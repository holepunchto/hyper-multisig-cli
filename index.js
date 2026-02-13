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

const DEFAULT_CONFIG_PATH = './config.json'
const DEFAULT_STORAGE_PATH = './storage'

const cmdRequestCore = command(
  'request-core',
  description('Create signing request'),
  flag('--force', 'Skip sanity checks'),
  flag('--peer-update-timeout <ms>', 'Peer update timeout in ms'),
  arg('<length>', 'Core length to request'),
  requestCore
)

const cmdVerifyCore = command(
  'verify-core',
  description('Verify multisig'),
  flag('--peer-update-timeout <ms>', 'Peer update timeout in ms'),
  arg('request', 'Signing request'),
  rest('[...responses]', 'Signing responses'),
  verifyCore
)

const cmdCommitCore = command(
  'commit-core',
  description('Commit multisig'),
  flag('--first-commit', 'First commit'),
  flag('--force-dangerous', 'Advanced option, it might break the core on misuse'),
  flag('--peer-update-timeout <ms>', 'Peer update timeout in ms'),
  arg('request', 'Signing request'),
  rest('[...responses]', 'Signing responses'),
  commitCore
)

const cmdRequestDrive = command(
  'request-drive',
  description('Create signing request'),
  flag('--force', 'Skip sanity checks'),
  flag('--peer-update-timeout <ms>', 'Peer update timeout in ms'),
  arg('<length>', 'Drive length to request'),
  requestDrive
)

const cmdVerifyDrive = command(
  'verify-drive',
  description('Verify multisig'),
  flag('--peer-update-timeout <ms>', 'Peer update timeout in ms'),
  arg('request', 'Signing request'),
  rest('[...responses]', 'Signing responses'),
  verifyDrive
)

const cmdCommitDrive = command(
  'commit-drive',
  description('Commit multisig'),
  flag('--first-commit', 'First commit'),
  flag('--force-dangerous', 'Advanced option, it might break the drive on misuse'),
  flag('--peer-update-timeout <ms>', 'Peer update timeout in ms'),
  arg('request', 'Signing request'),
  rest('[...responses]', 'Signing responses'),
  commitDrive
)

const cmd = command(
  'multisig',
  flag('--config|-c <config>', `Config file path (default to ${DEFAULT_CONFIG_PATH})`),
  flag('--storage|-s <storage>', `Storage path (default to ${DEFAULT_STORAGE_PATH})`),
  cmdRequestCore,
  cmdVerifyCore,
  cmdCommitCore,
  cmdRequestDrive,
  cmdVerifyDrive,
  cmdCommitDrive,
  () => console.log(cmd.help())
)

async function requestCore() {
  const length = +cmdRequestCore.args.length
  const { force, peerUpdateTimeout } = cmdRequestCore.flags

  if (!length) throw new Error('Invalid command')

  const { publicKeys, namespace, srcKey, quorum, store, swarm } = await setup()
  const srcCore = store.get({ key: idEnc.decode(srcKey) })
  const multisig = new Multisig(store, swarm)
  const res = await multisig.requestCore(publicKeys, namespace, srcCore, length, {
    force,
    peerUpdateTimeout: peerUpdateTimeout,
    quorum
  })

  printRequest(res.request)
  goodbye.exit()
}

async function verifyCore() {
  const { peerUpdateTimeout } = cmdVerifyCore.flags
  const request = cmdVerifyCore.args.request
  const responses = cmdVerifyCore.rest || []
  if (!request) throw new Error('Invalid command')

  console.info(`Verifying request ${request}`)
  console.info(`Responses:\n -${responses.join('\n -')}`)

  const { publicKeys, namespace, srcKey, quorum, store, swarm } = await setup()
  const srcCore = store.get({ key: idEnc.decode(srcKey) })
  const multisig = new Multisig(store, swarm)
  const res = await multisig.commitCore(publicKeys, namespace, srcCore, request, responses, {
    dryRun: true,
    peerUpdateTimeout: peerUpdateTimeout,
    quorum
  })

  printCommit(res.manifest, res.quorum, res.result, true)
  console.info(`Core key: ${res.result.destCore.key}`)
  goodbye.exit()
}

async function commitCore() {
  const request = cmdCommitCore.args.request
  const responses = cmdCommitCore.rest || []
  const { firstCommit, forceDangerous, peerUpdateTimeout } = cmdCommitCore.flags
  if (!request || !responses.length) throw new Error('Invalid command')

  console.info(`Committing request ${request}`)
  console.info(`Responses:\n -${responses.join('\n -')}`)

  const { publicKeys, namespace, srcKey, quorum, store, swarm } = await setup()
  const srcCore = store.get({ key: idEnc.decode(srcKey) })
  const multisig = new Multisig(store, swarm)
  const res = await multisig.commitCore(publicKeys, namespace, srcCore, request, responses, {
    skipTargetChecks: firstCommit,
    force: forceDangerous,
    peerUpdateTimeout: peerUpdateTimeout,
    quorum
  })

  printCommit(res.manifest, res.quorum, res.result)
  console.info(`Core key: ${res.result.destCore.key}`)
}

async function requestDrive() {
  const length = +cmdRequestDrive.args.length
  const { force, peerUpdateTimeout } = cmdRequestDrive.flags
  if (!length) throw new Error('Invalid command')

  const { publicKeys, namespace, srcKey, quorum, store, swarm } = await setup()
  const srcDrive = new Hyperdrive(store, idEnc.decode(srcKey))
  const multisig = new Multisig(store, swarm)
  const res = await multisig.requestDrive(publicKeys, namespace, srcDrive, length, {
    force,
    peerUpdateTimeout: peerUpdateTimeout,
    quorum
  })

  printRequest(res.request)
  goodbye.exit()
}

async function verifyDrive() {
  const { peerUpdateTimeout } = cmdVerifyCore.flags
  const request = cmdVerifyDrive.args.request
  const responses = cmdVerifyDrive.rest || []
  if (!request) throw new Error('Invalid command')
  console.info(`Committing request ${request}`)
  console.info(`Responses:\n -${responses.join('\n -')}`)

  const { publicKeys, namespace, srcKey, quorum, store, swarm } = await setup()
  const srcDrive = new Hyperdrive(store, idEnc.decode(srcKey))
  const multisig = new Multisig(store, swarm)
  const res = await multisig.commitDrive(publicKeys, namespace, srcDrive, request, responses, {
    dryRun: true,
    peerUpdateTimeout: peerUpdateTimeout,
    quorum
  })

  printCommit(res.manifest, res.quorum, res.result, true)
  console.info(`Drive key: ${res.result.db.destCore.key}`)
  goodbye.exit()
}

async function commitDrive() {
  const request = cmdCommitDrive.args.request
  const responses = cmdCommitDrive.rest || []
  const { firstCommit, forceDangerous, peerUpdateTimeout } = cmdCommitDrive.flags
  if (!request || !responses?.length) throw new Error('Invalid command')

  console.info(`Committing request ${request}`)
  console.info(`Responses:\n -${responses.join('\n -')}`)

  const { publicKeys, namespace, srcKey, quorum, store, swarm } = await setup()
  const srcDrive = new Hyperdrive(store, idEnc.decode(srcKey))
  const multisig = new Multisig(store, swarm)
  const res = await multisig.commitDrive(publicKeys, namespace, srcDrive, request, responses, {
    skipTargetChecks: firstCommit,
    force: forceDangerous,
    peerUpdateTimeout: peerUpdateTimeout,
    quorum
  })

  printCommit(res.manifest, res.quorum, res.result)
  console.info(`Drive key: ${res.result.db.destCore.key}`)
}

function printRequest(request) {
  const req = SignRequest.decode(request)
  const reqStr = z32.encode(request)
  const reqMsg = { key: req.id, length: req.length, treeHash: idEnc.normalize(req.treeHash) }
  console.log('Request:', JSON.stringify(reqMsg, null, 2))
  console.log('To sign, run:', `\nhypercore-sign ${reqStr}`)
}

function printCommit(manifest, quorum, result, dryRun) {
  if (dryRun) {
    console.log(`\nQuorum ${quorum} / ${manifest.quorum}`)
    console.log('\nReview batch to commit:', JSON.stringify(result, null, 2))
  } else {
    console.log('\nCommitted:', JSON.stringify(result, null, 2))
    console.log('\n~ DONE ~ Seeding now ~ Press Ctrl+C to exit ~\n')
  }
}

async function setup() {
  const configPath = cmd.flags.config || DEFAULT_CONFIG_PATH
  const storage = cmd.flags.storage || DEFAULT_STORAGE_PATH

  const { publicKeys, namespace, srcKey, bootstrap, quorum } = await loadConfig(configPath)
  const { store, swarm } = await replication(storage, bootstrap)
  return { publicKeys, namespace, srcKey, quorum, store, swarm }
}

/**
 * @type {function(): Promise<{ publicKeys: string[], namespace: string, srcKey: string }>}
 */
async function loadConfig(configPath) {
  const {
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
  return { publicKeys, namespace, srcKey, bootstrap, quorum }
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

module.exports = cmd
