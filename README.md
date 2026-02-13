![CI](https://github.com/holepunchto/hyper-multisig-cli/actions/workflows/ci.yml/badge.svg)

# Hyper Multisig Cli

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
  "publicKeys": ["abc123...", "abc456...", "abc789..."],
  "namespace": "holepunchto/my-app",
  "srcKey": "abcdef..."
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
