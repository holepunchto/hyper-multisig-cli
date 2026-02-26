#!/usr/bin/env node
const Corestore = require('corestore')
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

const cmdRequest = command(
  'request',
  description('Create signing request'),
  flag('--force', 'Skip sanity checks'),
  flag('--peer-update-timeout <ms>', 'Peer update timeout in ms'),
  arg('<length>', 'Core length to request'),
  request
)

const cmdVerify = command(
  'verify',
  description('Verify multisig'),
  flag(
    '--first-commit',
    'Set when this is the first commit to the multisig target, so it skips those checks'
  ),
  flag('--peer-update-timeout <ms>', 'Peer update timeout in ms'),
  arg('request', 'Signing request'),
  rest('[...responses]', 'Signing responses'),
  verify
)

const cmdCommit = command(
  'commit',
  description('Commit multisig'),
  flag(
    '--first-commit',
    'Set when this is the first commit to the multisig target, so it skips those checks'
  ),
  flag('--force-dangerous', 'Advanced option, it might break the core on misuse'),
  flag('--peer-update-timeout <ms>', 'Peer update timeout in ms'),
  arg('request', 'Signing request'),
  rest('[...responses]', 'Signing responses'),
  commit
)

const cmd = command(
  'multisig',
  flag('--config|-c <config>', `Config file path (default to ${DEFAULT_CONFIG_PATH})`),
  flag('--storage|-s <storage>', `Storage path (default to ${DEFAULT_STORAGE_PATH})`),
  cmdRequest,
  cmdVerify,
  cmdCommit,
  () => console.log(cmd.help())
)

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
        quorum
      })
      .done()
    request = res.request
  } else if (type === 'drive') {
    const srcDrive = new Hyperdrive(store, idEnc.decode(srcKey))
    const res = await multisig
      .requestDrive(publicKeys, namespace, srcDrive, length, {
        force,
        peerUpdateTimeout: peerUpdateTimeout,
        quorum
      })
      .done()
    request = res.request
  }
  printRequest(request)

  goodbye.exit()
}

async function verify() {
  const { firstCommit, peerUpdateTimeout } = cmdVerify.flags
  const request = cmdVerify.args.request
  const responses = cmdVerify.rest || []
  if (!request) throw new Error('Invalid command')
  console.info(`Committing request ${request}`)
  console.info(`Responses:\n -${responses.join('\n -')}`)

  const { type, publicKeys, namespace, srcKey, quorum, store, swarm } = await setup()
  const multisig = new Multisig(store, swarm)

  let runner
  if (type === 'core') {
    const srcCore = store.get({ key: idEnc.decode(srcKey) })
    runner = multisig.commitCore(publicKeys, namespace, srcCore, request, responses, {
      dryRun: true,
      skipTargetChecks: firstCommit,
      peerUpdateTimeout: peerUpdateTimeout,
      quorum
    })
  } else if (type === 'drive') {
    const srcDrive = new Hyperdrive(store, idEnc.decode(srcKey))
    runner = multisig.commitDrive(publicKeys, namespace, srcDrive, request, responses, {
      dryRun: true,
      skipTargetChecks: firstCommit,
      peerUpdateTimeout: peerUpdateTimeout,
      quorum
    })
  }
  setupProgressLogs(runner, type, firstCommit)

  const res = await runner.done()

  printCommit(res.manifest, res.quorum, res.result, true)
  console.info(`${type.toUpperCase()} Key: ${res.result.db.destCore.key} is safe to commit`)
  goodbye.exit()
}

async function commit() {
  const request = cmdCommit.args.request
  const responses = cmdCommit.rest || []
  const { firstCommit, forceDangerous, peerUpdateTimeout } = cmdCommit.flags
  if (!request || !responses?.length) throw new Error('Invalid command')

  console.info(`Committing request ${request}`)
  console.info(`Responses:\n -${responses.join('\n -')}`)

  const { type, publicKeys, namespace, srcKey, quorum, store, swarm } = await setup()
  const multisig = new Multisig(store, swarm)

  let runner
  if (type === 'core') {
    const srcCore = store.get({ key: idEnc.decode(srcKey) })
    runner = multisig.commitCore(publicKeys, namespace, srcCore, request, responses, {
      skipTargetChecks: firstCommit,
      force: forceDangerous,
      peerUpdateTimeout: peerUpdateTimeout,
      quorum
    })
  } else if (type === 'drive') {
    const srcDrive = new Hyperdrive(store, idEnc.decode(srcKey))
    runner = multisig.commitDrive(publicKeys, namespace, srcDrive, request, responses, {
      skipTargetChecks: firstCommit,
      force: forceDangerous,
      peerUpdateTimeout: peerUpdateTimeout,
      quorum
    })
  }
  setupProgressLogs(runner, type, firstCommit)

  const res = await runner.done()

  printCommit(res.manifest, res.quorum, res.result)
  console.info(`${type.toUpperCase()} key: ${res.result.db.destCore.key}`)
}

function setupProgressLogs(req, name, firstCommit) {
  req.on('verify-committable-start', (srcKey, tgtKey) => {
    console.log(
      `Verifying the ${name} is safe to commit (source ${idEnc.normalize(srcKey)} to multisig target ${idEnc.normalize(tgtKey)})`
    )
  })
  req.on('commit-start', () => {
    console.log(`Committing the ${name}...`)
  })
  req.on('verify-committed-start', (key) => {
    console.log(`Committed the ${name} (key ${idEnc.normalize(key)})`)
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
    length: runner.length,
    treeHash: idEnc.normalize(runner.treeHash)
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

async function setup() {
  const configPath = cmd.flags.config || DEFAULT_CONFIG_PATH
  const storage = cmd.flags.storage || DEFAULT_STORAGE_PATH

  const { type, publicKeys, namespace, srcKey, bootstrap, quorum } = await loadConfig(configPath)
  const { store, swarm } = await replication(storage, bootstrap)
  return { type, publicKeys, namespace, srcKey, quorum, store, swarm }
}

/**
 * @type {function(): Promise<{ publicKeys: string[], namespace: string, srcKey: string }>}
 */
async function loadConfig(configPath) {
  const {
    type = 'core',
    publicKeys,
    namespace,
    srcKey,
    bootstrap,
    quorum = null
  } = JSON.parse(await fs.readFile(configPath, 'utf-8'))

  if (!publicKeys?.length || !namespace || !srcKey) {
    throw new Error('Invalid config file')
  }

  if (bootstrap) console.info(`Using non-default bootstrap`)
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

cmd.parse()
