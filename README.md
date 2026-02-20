![CI](https://github.com/holepunchto/hyper-multisig-cli/actions/workflows/ci.yml/badge.svg)

# Hyper Multisig CLI

CLI to safely create, verify and commit multisig signing requests for hypercores and hyperdrives.

Includes sanity checks to avoid common mistakes and risky releases, like detecting conflicts and ensuring all cores are fully seeded by other peers before committing.

Uses [hyper-multisig](https://github.com/holepunchto/hyper-multisig) under the hood.

## Installation

```shell
npm i -g hyper-multisig-cli@latest
```

## Usage

```shell
hyper-multisig --help
hyper-multisig-bare --help
```

## Example

This example sets up a multisig hypercore with 1 signer and a quorum of 1, so it can be run by a single person. A more standard setup is 3 signers with a quorum of 2.

### Create Signing Key

First use [hypercore-sign](https://github.com/holepunchto/hypercore-sign) to create your signing key:

```
npm i -g hypercore-sign
hypercore-sign-generate-keys
```

Take note of your public key.

### Create Source Core

We just create a dummy source core for this example:

```
import Corestore from 'corestore'
import Hyperswarm from 'hyperswarm'

const desiredLength = 3

const store = new Corestore('temp-example-store')
const core = store.get({ name: 'source-core' })
await core.ready()

for (let i = core.length; i < desiredLength; i++) await core.append(`Block-${i}`)

const swarm = new Hyperswarm()
swarm.on('connection', (conn) => { store.replicate(conn) })
swarm.join(core.discoveryKey)
console.log(`Swarming key ${core.id} (length ${core.length})`)
```

Keep this process running, because we will need to download this hypercore to be able to create and commit the signing request.

### Create Config

Create `config.json` in your current directory

```json
{
  "publicKeys": ["paste-here-the-key-generated-by-hypercore-sign-generate-keys"],
  "namespace": "dummy-test-core",
  "srcKey": "paste-here-the-key-of-your-source-core"
}
```

Note that the key of the multisig hypercore is fully determined by the public keys and namespace. This means you can never use the same namespace with the same signers.

It is possible to switch to a different `srcKey`.

### Create Signing Request

```shell
hyper-multisig request-core 3 --first-commit
```

You should see an error that the source core is not well seeded. It errors because committing any requests in this situation is dangerous.

Fix it by running this script in another terminal window, filling in the correct source key:

```
import Corestore from 'corestore'
import Hyperswarm from 'hyperswarm'
import IdEnc from 'hypercore-id-encoding'

const stringKey = '' // use the key of your source core

const store = new Corestore('temp-example-seeder-store-${Math.random}')
const key = IdEnc.decode(stringKey)
const core = store.get({ key })
await core.ready()

const swarm = new Hyperswarm()
swarm.on('connection', (conn) => { store.replicate(conn) })
swarm.join(core.discoveryKey)
console.log(`Swarming key ${core.id}`)

core.download({ start: 0, end: -1 })
```

Note: in practice you would use a seeder service, like a [blind-peer](https://github.com/holepunchto/blind-peer), to ensure your source core is well seeded. Having two seeder processes running locally is not safe (if your computer is turned off, the core is no longer available).

Now rerun the command:

```shell
hyper-multisig request-core 3 --first-commit
```

Take note of the signing request. It looks like this:

```
hypercore-sign yebob...
```

### Sign Request

Run the hypercore-sign command, and take note of the result. It looks like

```
Reply with:

yeqmm...
```

### Verify Request

```
hyper-multisig verify-core --first-commit <the signing request> <your signing response>
```

You should see the confirmation that the core is safe to commit.

### Commit Request

Run the same command as above, but replace 'verify-core' with 'commit-core'.

```
hyper-multisig commit-core --first-commit <the signing request> <your signing response>
```

You should see logs like

```
Verifying the core is safe to commit (source <source key> to multisig target <target key>)
Opened connection
Opened connection
Committing the core...
Committed the core (key <target key>)
Waiting for remote seeders to pick up the changes...
Please add this key to the seeders now. The logs here will notify you when it is picked up by them. Do not shut down until that happens.
```

Do as the logs instruct, and add target key to 2 or more seeders. For this example, simple run 2 more seeder scripts like above, but this time for the target key.

Once the program detects at least 2 seeders have fully downloaded the multisig drive, it will inform you it is done. Shut down with ctrl-c.

Note: for any future updates to your multisig core, remove the `first-commit` flag.
