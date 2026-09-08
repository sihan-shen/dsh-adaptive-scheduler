# `@han_05/dsh-adaptive-scheduler`

An out-of-tree [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/DeepSeek-Harness) / Cordis plugin that provides an `adaptiveScheduler` service. It makes bounded, deterministic route-selection and escalation decisions from a configured route catalog; it does not implement providers, credentials, OAuth, network calls, or a UI.

This package is developed in the [`sihan-shen/DS-Plugins`](https://github.com/sihan-shen/DS-Plugins) monorepo. The source is also prepared for the standalone public repository [`sihan-shen/dsh-adaptive-scheduler`](https://github.com/sihan-shen/dsh-adaptive-scheduler).

当前开发重点在dsh-code-intelligence项目，其他项目迭代暂停。

## Compatibility and availability

- DSH / Cordis: `@deepseek-ai/cordis` **4.0.2**. This scheduler does not import DSH runtime APIs.
- DSH source availability: target packages are reviewed at upstream commit [`a66e4702047846cdaa10c66c9d3df3951f5ea70d`](https://github.com/deepseek-ai/DeepSeek-Harness/commit/a66e4702047846cdaa10c66c9d3df3951f5ea70d) for DSH `0.1.2-rc.1`.
- Scheduling contracts: `@han_05/dsh-scheduling-contracts` **^0.3.0** (required peer dependency).
- Source repository: public once `sihan-shen/dsh-adaptive-scheduler` is pushed.
- npm package: publication is intentionally blocked until the matching public `@han_05/dsh-scheduling-contracts` release exists. Do not treat the standalone repository as an npm-installable release before that prerequisite is met.

## Installation

After the two peer dependencies are available from your package source:

```sh
npm install @han_05/dsh-adaptive-scheduler @han_05/dsh-scheduling-contracts @deepseek-ai/cordis@4.0.2
```

Add the plugin to a Cordis / DSH patch. `cordis.patch.yml` in this package contains a complete example configuration. The plugin registers the service name `adaptiveScheduler` and observes `agent/request-error` plus `session/disposed` events.

## Development

Inside the parent repository:

```sh
pnpm --filter @han_05/dsh-scheduling-contracts build
pnpm --filter @han_05/dsh-adaptive-scheduler typecheck
pnpm --filter @han_05/dsh-adaptive-scheduler test
pnpm --filter @han_05/dsh-adaptive-scheduler run test:package-entry
```

The standalone repository includes a test-only fixture for the contracts package so its isolated build and tests do not depend on a sibling checkout. Generated files, test coverage, tarballs, and dependencies are intentionally excluded from version control.

## Boundaries

The scheduler accepts bounded configuration and scheduling inputs, retains only bounded performance history, and exposes validated route and scheduling decisions. It does not select or execute a provider directly. The deployment profile owns actual provider/model routes and must ensure its catalog and orchestrator configuration agree.
