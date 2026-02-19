const b4a = require('b4a')
const test = require('brittle')
const { spawn } = require('child_process')
const cenc = require('compact-encoding')
const Corestore = require('corestore')
const fs = require('fs').promises
const path = require('path')
const process = require('process')
const crypto = require('hypercore-crypto')
const idEnc = require('hypercore-id-encoding')
const createTestnet = require('hyperdht/testnet')
const SignMessages = require('hypercore-sign/lib/messages')
const SignSecure = require('hypercore-sign/lib/secure')
const SignRequest = require('hypercore-signing-request')
const Hyperdrive = require('hyperdrive')
const Hyperswarm = require('hyperswarm')
const NewlineDecoder = require('newline-decoder')
const sodium = require('sodium-native')
const { isBare } = require('which-runtime')
const z32 = require('z32')

const DEBUG = false
const EXECUTABLE = path.join(__dirname, isBare ? 'bin-bare.js' : 'bin.js')

test('core request and sign CLI flow', async (t) => {
  const { bootstrap, store, swarm, store2, swarm2, store3, swarm3, store4, swarm4 } = await setup(
    t,
    4
  )

  const tRequestCore = t.test('Request core CLI')
  tRequestCore.plan(2)
  const tCommitCore = t.test('Commit core CLI')
  tCommitCore.plan(1)

  const srcCore = await setupCore(t, store, swarm)

  const copy2 = store2.get(srcCore.key)
  await copy2.ready()
  swarm2.join(copy2.discoveryKey)
  await copy2.download({ start: 0, end: srcCore.length }).done()

  const copy3 = store3.get(srcCore.key)
  await copy3.ready()
  swarm3.join(copy3.discoveryKey)
  await copy3.download({ start: 0, end: srcCore.length }).done()

  const dir = await t.tmp()

  const cliStorageDir = path.join(dir, 'cli-storage')
  await fs.mkdir(cliStorageDir)
  const configLoc = path.join(dir, 'config.json')
  const { namespace, publicKeys, signers } = setupMultisig(undefined, 3)
  const config = { namespace, publicKeys, srcKey: idEnc.normalize(srcCore.key), bootstrap }
  await fs.writeFile(configLoc, JSON.stringify(config))

  const requestCoreProc = spawn(process.execPath, [
    EXECUTABLE,
    '--config',
    configLoc,
    '--storage',
    cliStorageDir,
    'request-core',
    srcCore.length
  ])

  // To avoid zombie processes in case there's an error
  process.on('exit', () => {
    requestCoreProc.kill('SIGKILL')
  })
  requestCoreProc.stderr.on('data', (d) => {
    console.error(d.toString())
    t.fail('There should be no stderr')
  })

  let request = null
  {
    const stdoutDec = new NewlineDecoder('utf-8')
    requestCoreProc.stdout.on('data', (d) => {
      if (DEBUG) console.log(d.toString())

      for (const line of stdoutDec.push(d)) {
        if (line.includes('hypercore-sign')) {
          tRequestCore.pass('sign request created')
          request = line.split('hypercore-sign ')[1]
        }
      }
    })
  }

  requestCoreProc.on('exit', (status) => {
    tRequestCore.is(status, 0, 'CLI proces exited cleanly')
  })

  await tRequestCore

  const responses = signers.slice(0, 2).map((signer) => signResponse(z32.decode(request), signer))

  {
    const commitCoreProc = spawn(process.execPath, [
      EXECUTABLE,
      '--config',
      configLoc,
      '--storage',
      cliStorageDir,
      'commit-core',
      '--first-commit',
      request,
      ...responses
    ])

    process.on('exit', () => {
      commitCoreProc.kill('SIGKILL')
    })
    commitCoreProc.stderr.on('data', (d) => {
      console.log('the stderr is', d.toString())
      console.error(d.toString())
      t.fail('There should be no stderr')
    })

    let coreKey = null
    {
      const stdoutDec = new NewlineDecoder('utf-8')
      commitCoreProc.stdout.on('data', async (d) => {
        if (DEBUG) console.log(d.toString())

        for (const line of stdoutDec.push(d)) {
          if (line.includes('Core key:')) {
            tCommitCore.pass('sign request committed')
            coreKey = line.split('Core key: ')[1]
          }

          if (line.includes('Committed the core (key')) {
            if (DEBUG) console.log('REMOTED BEGIN DOWNLOADING TARGET')
            const key = idEnc.decode(line.split('(key ')[1].slice(0, 52))
            const tgtCopy = store2.get(key)
            await tgtCopy.ready()
            swarm2.join(tgtCopy.discoveryKey)
            tgtCopy.download({ start: 0, end: -1 })

            const tgtCopy2 = store3.get(key)
            await tgtCopy2.ready()
            swarm3.join(tgtCopy2.discoveryKey)
            await tgtCopy2.download({ start: 0, end: -1 })
          }
        }
      })
    }

    await tCommitCore

    {
      /** @type {import('hypercore')} */
      const core = store4.get(idEnc.decode(coreKey))
      t.teardown(() => core.close())
      await core.ready()
      swarm4.join(core.discoveryKey)

      t.is(b4a.toString(await core.get(2)), 'content 2', 'multisig core is seeded')
    }

    const tShutdown = t.test('Shutdown logic')
    tShutdown.plan(1)
    commitCoreProc.on('exit', (status) => {
      tShutdown.pass('commit core process shuts down cleanly')
    })
    commitCoreProc.kill('SIGINT')
    await tShutdown
  }

  // second commit
  {
    const commitCoreProc = spawn(process.execPath, [
      EXECUTABLE,
      '--config',
      configLoc,
      '--storage',
      cliStorageDir,
      'commit-core',
      request,
      ...responses
    ])

    process.on('exit', () => {
      commitCoreProc.kill('SIGKILL')
    })
    commitCoreProc.stderr.on('data', (d) => {
      console.log('the stderr is', d.toString())
      console.error(d.toString())
      t.fail('There should be no stderr')
    })

    let coreKey = null
    {
      const stdoutDec = new NewlineDecoder('utf-8')
      commitCoreProc.stdout.on('data', (d) => {
        if (DEBUG) console.log(d.toString())

        for (const line of stdoutDec.push(d)) {
          if (line.includes('Core key:')) {
            tCommitCore.pass('sign request committed')
            coreKey = line.split('Core key: ')[1]
          }
        }
      })
    }

    await tCommitCore

    const tShutdown = t.test('Shutdown logic')
    tShutdown.plan(1)
    commitCoreProc.on('exit', (status) => {
      tShutdown.pass('commit core process shuts down cleanly')
    })
    commitCoreProc.kill('SIGINT')
    await tShutdown
  }
})

test('drive request and sign CLI flow', async (t) => {
  const { bootstrap, store, swarm, store2, swarm2, store3, swarm3, store4, swarm4 } = await setup(
    t,
    4
  )

  const tRequestDrive = t.test('Request core CLI')
  tRequestDrive.plan(2)
  const tCommitDrive = t.test('Commit core CLI')
  tCommitDrive.plan(1)

  const srcDrive = await setupDrive(t, store, swarm)

  const copy2 = new Hyperdrive(store2, srcDrive.key)
  await copy2.ready()
  swarm2.join(copy2.discoveryKey)
  await copy2.getBlobs()
  await copy2.db.core.download({ start: 0, end: srcDrive.version })
  await copy2.blobs.core.download({
    start: 0,
    end: await srcDrive.getBlobsLength(srcDrive.version)
  })

  const copy3 = new Hyperdrive(store3, srcDrive.key)
  await copy3.ready()
  swarm3.join(copy3.discoveryKey)
  await copy3.getBlobs()
  await copy3.db.core.download({ start: 0, end: srcDrive.version })
  await copy3.blobs.core.download({
    start: 0,
    end: await srcDrive.getBlobsLength(srcDrive.version)
  })

  const dir = await t.tmp()

  const cliStorageDir = path.join(dir, 'cli-storage')
  await fs.mkdir(cliStorageDir)
  const configLoc = path.join(dir, 'config.json')
  const { namespace, publicKeys, signers } = setupMultisig(undefined, 3)
  const config = { namespace, publicKeys, srcKey: idEnc.normalize(srcDrive.key), bootstrap }
  await fs.writeFile(configLoc, JSON.stringify(config))

  const requestDriveProc = spawn(process.execPath, [
    EXECUTABLE,
    '--config',
    configLoc,
    '--storage',
    cliStorageDir,
    'request-drive',
    srcDrive.core.length
  ])

  // To avoid zombie processes in case there's an error
  process.on('exit', () => {
    requestDriveProc.kill('SIGKILL')
  })
  requestDriveProc.stderr.on('data', (d) => {
    console.error(d.toString())
    t.fail('There should be no stderr')
  })

  let request = null
  {
    const stdoutDec = new NewlineDecoder('utf-8')
    requestDriveProc.stdout.on('data', (d) => {
      if (DEBUG) console.log(d.toString())

      for (const line of stdoutDec.push(d)) {
        if (line.includes('hypercore-sign')) {
          tRequestDrive.pass('sign request created')
          request = line.split('hypercore-sign ')[1]
        }
      }
    })
  }

  requestDriveProc.on('exit', (status) => {
    tRequestDrive.is(status, 0, 'CLI proces exited cleanly')
  })

  await tRequestDrive

  const responses = signers.slice(0, 2).map((signer) => signResponse(z32.decode(request), signer))
  {
    const commitDriveProc = spawn(process.execPath, [
      EXECUTABLE,
      '--config',
      configLoc,
      '--storage',
      cliStorageDir,
      'commit-drive',
      '--first-commit',
      request,
      ...responses
    ])

    process.on('exit', () => {
      commitDriveProc.kill('SIGKILL')
    })
    commitDriveProc.stderr.on('data', (d) => {
      console.log('the stderr is', d.toString())
      console.error(d.toString())
      t.fail('There should be no stderr')
    })

    let driveKey = null
    {
      const stdoutDec = new NewlineDecoder('utf-8')
      commitDriveProc.stdout.on('data', async (d) => {
        if (DEBUG) console.log(d.toString())

        for (const line of stdoutDec.push(d)) {
          if (line.includes('Drive key:')) {
            tCommitDrive.pass('sign request committed')
            driveKey = line.split('Drive key: ')[1]
          }

          if (line.includes('Committed the drive (key')) {
            if (DEBUG) console.log('REMOTES BEGIN DOWNLOADING TARGET')
            const key = idEnc.decode(line.split('(key ')[1].slice(0, 52))

            const tgtCopy = new Hyperdrive(store2, key)
            await tgtCopy.ready()
            swarm2.join(tgtCopy.discoveryKey)
            await tgtCopy.getBlobs()
            await tgtCopy.db.core.download({ start: 0, end: -1 })
            await tgtCopy.blobs.core.download({
              start: 0,
              end: -1
            })

            const tgtCopy2 = new Hyperdrive(store3, key)
            await tgtCopy2.ready()
            swarm3.join(tgtCopy2.discoveryKey)
            await tgtCopy2.getBlobs()
            await tgtCopy2.db.core.download({ start: 0, end: -1 })
            await tgtCopy2.blobs.core.download({
              start: 0,
              end: -1
            })
          }
        }
      })
    }

    await tCommitDrive

    {
      const drive = new Hyperdrive(store4, idEnc.decode(driveKey))
      t.teardown(() => drive.close())
      await drive.ready()
      swarm4.join(drive.discoveryKey)

      t.is(
        b4a.toString(await drive.checkout(srcDrive.version).get('/file2')),
        'file2 content',
        'multisig drive is seeded'
      )
    }

    const tShutdown = t.test('Shutdown logic')
    tShutdown.plan(1)

    commitDriveProc.on('exit', (status) => {
      tShutdown.pass('commit drive process shuts down cleanly')
    })
    commitDriveProc.kill('SIGINT')
    await tShutdown
  }

  // second commit
  {
    const commitDriveProc = spawn(process.execPath, [
      EXECUTABLE,
      '--config',
      configLoc,
      '--storage',
      cliStorageDir,
      'commit-drive',
      request,
      ...responses
    ])

    process.on('exit', () => {
      commitDriveProc.kill('SIGKILL')
    })
    commitDriveProc.stderr.on('data', (d) => {
      console.log('the stderr is', d.toString())
      console.error(d.toString())
      t.fail('There should be no stderr')
    })

    let driveKey = null
    {
      const stdoutDec = new NewlineDecoder('utf-8')
      commitDriveProc.stdout.on('data', (d) => {
        if (DEBUG) console.log(d.toString())

        for (const line of stdoutDec.push(d)) {
          if (line.includes('Drive key:')) {
            tCommitDrive.pass('sign request committed')
            driveKey = line.split('Drive key: ')[1]
          }
        }
      })
    }

    await tCommitDrive

    const tShutdown = t.test('Shutdown logic')
    tShutdown.plan(1)

    commitDriveProc.on('exit', (status) => {
      tShutdown.pass('commit drive process shuts down cleanly')
    })
    commitDriveProc.kill('SIGINT')
    await tShutdown
  }
})

async function setupTestnet(t) {
  const testnet = await createTestnet()
  t.teardown(() => testnet.destroy(), { order: 5000 })
  const bootstrap = testnet.bootstrap
  return { testnet, bootstrap }
}

async function setup(t, n = 1, network) {
  const res = network ?? (await setupTestnet(t))
  const { bootstrap } = res

  for (let step = 1; step <= n; step++) {
    const storage = await t.tmp()
    const store = new Corestore(storage)
    t.teardown(() => store.close(), { order: 4000 })
    const swarm = new Hyperswarm({ bootstrap })
    t.teardown(() => swarm.destroy(), { order: 3000 })

    swarm.on('connection', (conn) => store.replicate(conn))

    const nstring = step > 1 ? step : ''
    res[`storage${nstring}`] = storage
    res[`store${nstring}`] = store
    res[`swarm${nstring}`] = swarm
  }

  return res
}

function setupMultisig(namespace = 'holepunchto/my-test', numSigners = 5) {
  const signers = []
  for (let i = 0; i < numSigners; i++) {
    const seed = sodium.sodium_malloc(sodium.randombytes_SEEDBYTES)
    sodium.randombytes_buf(seed)
    const password = sodium.sodium_malloc(8)
    sodium.randombytes_buf_deterministic(password, seed)

    const keys = SignSecure.generateKeys(password)
    signers.push({ ...keys, seed })
  }
  const publicKeys = signers.map((signer) => idEnc.normalize(signer.publicKey))

  return { namespace, signers, publicKeys }
}

function signResponse(request, signer) {
  const { clonedSigner, decodedReq, signatures } = sign(request, signer)
  const res = cenc.encode(SignMessages.Response, {
    version: decodedReq.version,
    requestHash: crypto.hash(request),
    publicKey: clonedSigner.publicKey,
    signatures
  })
  return z32.encode(res)
}

function sign(request, signer) {
  // clone to avoid mutation
  const clonedSigner = Object.keys(signer).reduce((acc, key) => {
    acc[key] = b4a.from(signer[key])
    return acc
  }, {})

  const decodedReq = SignRequest.decode(request)
  const signables = SignRequest.signable(clonedSigner.publicKey, decodedReq)

  const password = sodium.sodium_malloc(8)
  sodium.randombytes_buf_deterministic(password, clonedSigner.seed)

  const signatures = SignSecure.sign(signables, clonedSigner.secretKey, password)
  return { clonedSigner, decodedReq, signatures }
}

async function setupCore(t, store, swarm) {
  /** @type {import('hypercore')} */
  const core = store.get({ name: 'test-core' })
  t.teardown(() => core.close())
  await core.ready()
  swarm.join(core.discoveryKey)

  await core.append(b4a.from('content 0'))
  await core.append(b4a.from('content 1'))
  await core.append(b4a.from('content 2'))
  return core
}

async function setupDrive(t, store, swarm) {
  const drive = new Hyperdrive(store)
  t.teardown(() => drive.close())
  await drive.ready()
  swarm.join(drive.discoveryKey)

  await drive.put('/file1', 'file1 content')
  await drive.put('/file2', 'file2 content')
  await drive.put('/file3', 'file3 content')
  return drive
}
