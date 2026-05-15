#!/usr/bin/env node
const Corestore = require('corestore')
const process = require('process')
const fs = require('fs').promises
const goodbye = require('graceful-goodbye')
const Multisig = require('hyper-multisig')
const idEnc = require('hypercore-id-encoding')
const SignRequest = require('hypercore-signing-request')
const Hyperdrive = require('hyperdrive')
const Hyperswarm = require('hyperswarm')
const { command, flag, arg, rest, description } = require('paparam')
const z32 = require('z32')

const DEFAULT_CONFIG_PATH = './multisig.json'
const DEFAULT_STORAGE_PATH = './storage'
const DEFAULT_SEED_LOG_INTERVAL = 15000

const cmdLink = command('link', description('Create multisig key'), wrapErrHandler(link))

const cmdRequest = command(
  'request',
  description('Create signing request'),
  flag('--force', 'Skip sanity checks'),
  flag('--peer-update-timeout <ms>', 'Peer update timeout in ms'),
  arg('<length>', 'Core length to request'),
  wrapErrHandler(request)
)

const cmdVerify = command(
  'verify',
  description('Verify multisig'),
  flag(
    '--first-commit',
    'Set when this is the first commit to the multisig target, so it skips those checks'
  ),
  flag('--skip-target-well-seeded', 'Skip checking multisig target is well seeded'),

  flag('--peer-update-timeout <ms>', 'Peer update timeout in ms'),
  arg('request', 'Signing request'),
  rest('[...responses]', 'Signing responses'),
  wrapErrHandler(verify)
)

const cmdCommit = command(
  'commit',
  description('Commit multisig'),
  flag('--swarm-client-only', 'Swarm in client mode only'),
  flag(
    '--first-commit',
    'Set when this is the first commit to the multisig target, so it skips those checks'
  ),
  flag('--skip-target-well-seeded', 'Skip checking multisig target is well seeded'),
  flag('--force-dangerous', 'Advanced option, it might break the core on misuse'),
  flag('--peer-update-timeout <ms>', 'Peer update timeout in ms'),
  arg('request', 'Signing request'),
  rest('[...responses]', 'Signing responses'),
  wrapErrHandler(commit)
)

const cmdSeed = command(
  'seed',
  description('Seed both the source and multisig cores/drives'),
  flag('--log-interval <logInterval>', 'Interval in ms to log replication status').default(
    DEFAULT_SEED_LOG_INTERVAL
  ),
  wrapErrHandler(seed)
)

const cmd = command(
  'multisig',
  flag('--config|-c <config>', `Config file path (default to ${DEFAULT_CONFIG_PATH})`),
  flag('--storage|-s <storage>', `Storage path (default to ${DEFAULT_STORAGE_PATH})`),
  cmdLink,
  cmdRequest,
  cmdVerify,
  cmdCommit,
  cmdSeed,
  () => console.log(cmd.help())
)

async function link() {
  const { publicKeys, namespace, quorum } = await setup({
    withReplication: false,
    srcKeyRequired: false
  })
  const key = Multisig.getCoreKey(publicKeys, namespace, { quorum })
  console.info(`pear://${idEnc.normalize(key)}`)
}

async function request() {
  const length = +cmdRequest.args.length
  const { force, peerUpdateTimeout } = cmdRequest.flags
  if (!length) throw new Error('Invalid command')

  const { type, publicKeys, namespace, srcKey, quorum, store, swarm } = await setup()
  const multisig = new Multisig(store, swarm)

  let request
  if (type === 'core') {
    const srcCore = store.get({ key: idEnc.decode(srcKey) })
    const res = await multisig
      .requestCore(publicKeys, namespace, srcCore, length, {
        force,
        peerUpdateTimeout: peerUpdateTimeout,
        quorum,
        legacy: true // legacy requests compat with hypercore-sign v3
      })
      .done()
    request = res.request
  } else {
    const srcDrive = new Hyperdrive(store, idEnc.decode(srcKey))
    const req = await multisig.requestDrive(publicKeys, namespace, srcDrive, length, {
      force,
      peerUpdateTimeout: peerUpdateTimeout,
      quorum,
      legacy: true // legacy requests compat with hypercore-sign v3
    })

    req.on('getting-src-blobs', () => {
      console.log('Getting the source blobs...')
    })
    req.on('verify-db-requestable-start', () => {
      console.log('Verifying the db core is requestable....')
    })
    req.on('getting-blobs-length', () => {
      console.log('Getting the blobs length (this can take a while)...')
    })
    req.on('verify-blobs-requestable-start', () => {
      console.log('Verifying the blobs core is requestable...')
    })
    req.on('creating-drive', () => {
      console.log('Creating the drive...')
    })

    const res = await req.done()
    request = res.request
  }
  printRequest(request)

  goodbye.exit()
}

async function verify() {
  const { firstCommit, peerUpdateTimeout, skipTargetWellSeeded } = cmdVerify.flags
  const request = cmdVerify.args.request
  const responses = cmdVerify.rest || []
  if (!request) throw new Error('Invalid command')
  console.info(`Verifying request ${request}`)
  console.info(`Responses:\n -${responses.join('\n -')}`)

  const { type, publicKeys, namespace, srcKey, quorum, store, swarm } = await setup()
  const multisig = new Multisig(store, swarm)

  let runner
  if (type === 'core') {
    const srcCore = store.get({ key: idEnc.decode(srcKey) })
    runner = multisig.commitCore(publicKeys, namespace, srcCore, request, responses, {
      dryRun: true,
      skipTargetChecks: firstCommit,
      skipTargetWellSeeded,
      peerUpdateTimeout: peerUpdateTimeout,
      quorum
    })
  } else {
    const srcDrive = new Hyperdrive(store, idEnc.decode(srcKey))
    runner = multisig.commitDrive(publicKeys, namespace, srcDrive, request, responses, {
      dryRun: true,
      skipTargetChecks: firstCommit,
      skipTargetWellSeeded,
      peerUpdateTimeout: peerUpdateTimeout,
      quorum
    })
  }
  setupProgressLogs(runner, type, firstCommit, true)

  const res = await runner.done()

  printCommit(res.manifest, res.quorum, res.result, true)
  const destKey = type === 'core' ? res.result.destCore.key : res.result.db.destCore.key
  console.info(`${type} key: ${destKey} is safe to commit`)
  goodbye.exit()
}

async function commit() {
  const request = cmdCommit.args.request
  const responses = cmdCommit.rest || []
  const { swarmClientOnly, firstCommit, skipTargetWellSeeded, forceDangerous, peerUpdateTimeout } =
    cmdCommit.flags

  if (!request || !responses?.length) throw new Error('Invalid command')

  console.info(`Committing request ${request}`)
  console.info(`Responses:\n -${responses.join('\n -')}`)

  const { type, publicKeys, namespace, srcKey, quorum, store, swarm } = await setup()
  const multisig = new Multisig(store, swarm)

  let runner
  if (type === 'core') {
    const srcCore = store.get({ key: idEnc.decode(srcKey) })
    runner = multisig.commitCore(publicKeys, namespace, srcCore, request, responses, {
      swarmAsServer: !swarmClientOnly,
      skipTargetChecks: firstCommit,
      skipTargetWellSeeded,
      force: forceDangerous,
      peerUpdateTimeout: peerUpdateTimeout,
      quorum
    })
  } else {
    const srcDrive = new Hyperdrive(store, idEnc.decode(srcKey))
    runner = multisig.commitDrive(publicKeys, namespace, srcDrive, request, responses, {
      swarmAsServer: !swarmClientOnly,
      skipTargetChecks: firstCommit,
      skipTargetWellSeeded,
      force: forceDangerous,
      peerUpdateTimeout: peerUpdateTimeout,
      quorum
    })
  }
  setupProgressLogs(runner, type, firstCommit, false)

  const res = await runner.done()

  printCommit(res.manifest, res.quorum, res.result)
  const destKey = type === 'core' ? res.result.destCore.key : res.result.db.destCore.key
  console.info(`${type} key: ${destKey}`)
}

async function seed() {
  const logInterval = cmdSeed.flags.logInterval
    ? +cmdSeed.flags.logInterval
    : DEFAULT_SEED_LOG_INTERVAL
  const { type, publicKeys, namespace, srcKey, multisigKey, quorum, store, swarm } = await setup()

  const multisig = new Multisig(store, swarm)
  console.log('\nPreparing to seed ~ Press Ctrl+C to exit\n')

  const allCores = []

  if (type === 'core') {
    const srcCore = store.get({ key: idEnc.decode(srcKey) })
    await srcCore.ready()
    swarm.join(srcCore.discoveryKey)
    srcCore.download({ start: 0, end: -1 })

    let tgtCore
    if (multisigKey) {
      tgtCore = store.get({ key: idEnc.decode(multisigKey) })
      await tgtCore.ready()
    } else {
      const res = await multisig.createCore(publicKeys, namespace, { quorum })
      tgtCore = res.core
    }
    swarm.join(tgtCore.discoveryKey)
    tgtCore.download({ start: 0, end: -1 })

    allCores.push({ core: srcCore, label: 'Source' }, { core: tgtCore, label: 'Multisig' })
  } else {
    const srcDrive = new Hyperdrive(store, idEnc.decode(srcKey))
    await srcDrive.ready()
    swarm.join(srcDrive.discoveryKey)
    srcDrive.db.core.download({ start: 0, end: -1 })
    await srcDrive.getBlobs()
    srcDrive.blobs.core.download({ start: 0, end: -1 })

    let tgtCore
    let tgtBlobsCore
    if (multisigKey) {
      const tgtDrive = new Hyperdrive(store, idEnc.decode(multisigKey))
      await tgtDrive.ready()
      tgtCore = tgtDrive.db.core
      await tgtDrive.getBlobs()
      tgtBlobsCore = tgtDrive.blobs.core
    } else {
      const res = await multisig.createDrive(publicKeys, namespace, { quorum })
      tgtCore = res.core
      tgtBlobsCore = res.blobsCore
      await tgtBlobsCore.ready()
    }
    swarm.join(tgtCore.discoveryKey)
    tgtCore.download({ start: 0, end: -1 })
    tgtBlobsCore.download({ start: 0, end: -1 })

    allCores.push(
      { core: srcDrive.db.core, label: 'Source DB' },
      { core: srcDrive.blobs.core, label: 'Source Blobs' },
      { core: tgtCore, label: 'Multisig DB' },
      { core: tgtBlobsCore, label: 'Multisig Blobs' }
    )
  }

  for (const { core, label } of allCores) {
    console.log(`${label} core:`)
    console.log(`  key:      ${idEnc.normalize(core.key)}`)
    console.log(`  keyHex:   ${core.key.toString('hex')}`)
    console.log(`  length:   ${core.length}`)
    console.log(`  treeHash: ${idEnc.normalize(await core.treeHash())}\n`)
  }

  const interval = setInterval(() => {
    allCores.forEach(({ core, label }) => {
      const peers = core.peers.length
      let fullyDownloadedPeers = 0
      for (const p of core.peers) {
        if (p.remoteContiguousLength >= core.length) fullyDownloadedPeers++
      }
      console.log(
        `${label} core: ${peers} peers, ${fullyDownloadedPeers} fully downloaded, length: ${core.length}`
      )
    })
    console.log()
  }, logInterval)
  goodbye(() => clearInterval(interval))
}

function setupProgressLogs(req, name, firstCommit, dryRun) {
  req.on('verify-committable-start', (srcKey, tgtKey) => {
    console.log(
      `Verifying the ${name} is safe to commit: source ${idEnc.normalize(srcKey)} (hex: ${srcKey.toString('hex')}) to multisig target ${idEnc.normalize(tgtKey)} (hex: ${tgtKey.toString('hex')})`
    )
  })
  req.on('commit-start', () => {
    console.log(dryRun ? `Dry run the ${name} commit` : `Committing the ${name}...`)
  })
  req.on('verify-committed-start', (key) => {
    console.log(`Committed the ${name}, key ${idEnc.normalize(key)} (hex: ${key.toString('hex')})`)
    console.log('Waiting for remote seeders to pick up the changes...')
    if (firstCommit) {
      console.log(
        'Please add this key to the seeders now. The logs here will notify you when it is picked up by them. Do not shut down until that happens.'
      )
    }
  })
}

function printRequest(request) {
  const runner = SignRequest.decode(request)
  const reqStr = z32.encode(request)
  const reqMsg = {
    key: runner.id,
    keyHex: runner.key.toString('hex'),
    length: runner.length,
    treeHash: idEnc.normalize(runner.treeHash),
    treeHashHex: runner.treeHash.toString('hex')
  }
  console.log('Request:', JSON.stringify(reqMsg, null, 2))
  console.log('To sign, run:', `\nhypercore-sign ${reqStr}`)
}

function printCommit(manifest, quorum, result, dryRun) {
  if (dryRun) {
    console.log(`\nQuorum: ${quorum} / ${manifest.quorum}`)
    console.log('\nReview batch to commit:', JSON.stringify(result, null, 2))
  } else {
    console.log('\nCommitted:', JSON.stringify(result, null, 2))
    console.log('\n~ DONE ~ Seeding now ~ Press Ctrl+C to exit ~\n')
  }
}

async function setup(opts = {}) {
  const configPath = cmd.flags.config || DEFAULT_CONFIG_PATH
  const storage = cmd.flags.storage || DEFAULT_STORAGE_PATH

  const { withReplication = true } = opts

  const { type, publicKeys, namespace, srcKey, bootstrap, quorum } = await loadConfig(
    configPath,
    opts
  )

  let store, swarm
  if (withReplication) {
    const res = await replication(storage, bootstrap)
    store = res.store
    swarm = res.swarm
  }

  return { type, publicKeys, namespace, srcKey, quorum, store, swarm }
}

/**
 * @type {function(): Promise<{ publicKeys: string[], namespace: string, srcKey: string }>}
 */
async function loadConfig(configPath, opts = {}) {
  const {
    type,
    publicKeys,
    namespace,
    srcKey,
    bootstrap,
    quorum = null,
    multisigKey = null
  } = JSON.parse(await fs.readFile(configPath, 'utf-8'))

  const { srcKeyRequired = true } = opts

  if (!(type === 'core' || type === 'drive')) {
    throw new Error(`type must be either core or drive. Saw '${type}'`)
  }
  if (!namespace) throw new Error('namespace must be set')
  if (!publicKeys?.length) throw new Error('publicKeys must be set and include at least 1 key')
  for (let i = 0; i < publicKeys.length; i++) {
    if (!idEnc.isValid(publicKeys[i])) throw new Error(`invalid publicKey ${i}: '${publicKeys[i]}'`)
  }

  if (srcKeyRequired && !srcKey) throw new Error('srcKey must be set')
  if (srcKey && !idEnc.isValid(srcKey)) throw new Error(`invalid srcKey: '${srcKey}'`)

  if (bootstrap) console.info(`Using non-default bootstrap`)

  if (multisigKey) {
    const calculatedKeyBuffer = Multisig.getCoreKey(publicKeys, namespace, { quorum })
    const calculatedKey = idEnc.normalize(calculatedKeyBuffer)
    const passedInKey = idEnc.normalize(multisigKey)
    if (passedInKey !== calculatedKey) {
      throw new Error(
        `multisigKey does not correspond to the key generated from the config, expected ${calculatedKey} (hex: ${calculatedKeyBuffer.toString('hex')})`
      )
    }
  }

  return { type, publicKeys, namespace, srcKey, bootstrap, quorum }
}

/**
 * @type {function(): Promise<{ store: Corestore, swarm: Hyperswarm }>}
 */
async function replication(storage, bootstrap) {
  const store = new Corestore(storage)
  goodbye(() => store.close(), 20)
  await store.ready()

  const swarm = new Hyperswarm({ bootstrap })
  goodbye(() => swarm.destroy(), 10)
  swarm.on('connection', (conn, peer) => {
    console.info('Opened connection')

    conn.on('close', () => console.info('Closed connection'))
    store.replicate(conn)
  })
  return { store, swarm }
}

function wrapErrHandler(func) {
  const res = async () => {
    try {
      await func()
    } catch (e) {
      console.error(e)
      process.exit(1)
    }
  }
  return res
}

cmd.parse()
