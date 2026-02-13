![CI](https://github.com/holepunchto/hyper-multisig-cli/actions/workflows/ci.yml/badge.svg)

# hyper-multisig-cli

- Create signing request
- Commit changes to multisig core/drive (dry-run supported)

## Usage

```shell
npm i -g hyper-multisig-cli@latest
hyper-multisig
```

## Example

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
# Request: {
#   "key": "eknig6fytx46k8bdqzssx94b...",
#   "length": 1,
#   "treeHash": "87xpyhx87kcsoes4djbicpb..."
# }
# To sign, run:
# hypercore-sign yeyoyx464ba6x4w3pytpwg1dka4n7kk6dhsq...
```

Use [hypercore-sign](https://github.com/holepunchto/hypercore-sign) to create signing responses

Dry-run

```shell
hyper-multisig commit-core --dry-run <request> <response1> <response2>
# Quorum 2 / 3
# Review batch to commit: {
#   "destCore": {
#     "key": "yej8egs9xyud1px3ywnscx7...",
#     "length": 0,
#     "treeHash": "zcakemy6cmak9s19bj8e..."
#   },
#   "srcCore": {
#     "key": "w94a4mrokgp4hu757rhipc3is...",
#     "length": 1,
#     "treeHash": "87xpyhx87kcsoes4djbic..."
#   },
#   "batch": {
#     "key": "yej8egs9xyud1px3ywnscx7opp...",
#     "length": 1,
#     "treeHash": "87xpyhx87kcsoes4djbicpb..."
#   }
# }
```

Commit multisig

```shell
hyper-multisig commit-core <request> <response1> <response2>
# Committed: {
#   "destCore": {
#     "key": "yej8egs9xyud1px3ywnscx7...",
#     "length": 1,
#     "treeHash": "zcakemy6cmak9s19bj8e..."
#   },
#   "srcCore": {
#     "key": "w94a4mrokgp4hu757rhipc3is...",
#     "length": 1,
#     "treeHash": "87xpyhx87kcsoes4djbic..."
#   },
#   "batch": {
#     "key": "yej8egs9xyud1px3ywnscx7opp...",
#     "length": 1,
#     "treeHash": "87xpyhx87kcsoes4djbicpb..."
#   }
# }
```
