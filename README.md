![CI](https://github.com/holepunchto/hyper-multisig-cli/actions/workflows/ci.yml/badge.svg)

# hyper-multisig-cli

- Create signing request
- Commit changes to multisig core/drive (dry-run supported)

## Installation

```shell
npm i -g hyper-multisig-cli@latest
```

## Usage

```shell
hyper-multisig --help
hyper-multisig-bare --help
```

### Example

Use [hypercore-sign](https://github.com/holepunchto/hypercore-sign) to create public keys

Create `config.json`

```json
{
  "publicKeys": ["o37a1xctj7zhiuz41rk...", "qgbd9nhm76ynh54mp7g...", "schnuhchkp9xbz4..."],
  "namespace": "holepunchto/my-app",
  "srcKey": "w94a4mrokgp4hu757rh..."
}
```

Create signing request

```shell
hyper-multisig request-core 1
```

Use [hypercore-sign](https://github.com/holepunchto/hypercore-sign) to create signing responses

Dry-run

```shell
hyper-multisig commit-core --dry-run <request> <response1> <response2>
```

Commit multisig

```shell
hyper-multisig commit-core <request> <response1> <response2>
```
