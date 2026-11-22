/**
 * `@hyperion/protocol`
 *
 * The facts both halves of Hyperion have to agree on, in one place that neither the frontend nor
 * the backend owns.
 *
 * Hyperion is a router, not a bridge. It never decides on its own that a cross-chain message is
 * real; it hands transfers to rails that already made that decision and were audited for it, and
 * it keeps the bookkeeping, the limits and the fees. That split is the reason this package exists.
 * Both chains, the indexer, the keeper and the app all need the same answer to the same questions:
 * what a route is called, how a Stellar address is encoded, how many decimal places survive a hop,
 * how a flow window decays, and what a revert meant. Four implementations of those answers is
 * three implementations too many.
 *
 * Everything here works on `Uint8Array` and `bigint`. No `Buffer`, no runtime dependencies, no
 * environment assumptions, because the same module is imported by a browser bundle and a Fastify
 * process and neither should be paying for the other's conveniences.
 *
 * The ABI modules are generated from the Foundry build and live behind `@hyperion/protocol/abi`,
 * so an app that only wants to format an amount does not drag forty kilobytes of JSON into its
 * bundle to get it.
 */

// Bytes and hex, which everything else is built out of.
export * from "./bytes.js";

// The rails, and what is true about each one.
export * from "./routes.js";

// Canonical route/lane identities, including exact source and destination asset representations.
export * from "./lanes.js";

// The error vocabulary shared by both chains, with a sentence of help per error.
export * from "./errors.js";

// Stellar addresses: parsing, encoding, and the two wire forms the rails want.
export * from "./addresses.js";

// The notes Hyperion writes into a rail's payload.
export * from "./notes.js";

// Fees, decimal conversion, and formatting that never touches a float.
export * from "./amounts.js";

// Sliding flow windows, the same arithmetic both routers run.
export * from "./flow.js";

// Reading CCTP V2 messages, which is all this side ever does with them.
export * from "./cctp.js";

// Turning one raw router event (Soroban RPC XDR or an EVM log) into a typed, versioned record.
export * from "./events.js";

// The wire layouts and error tables as data, and a breaking-versus-compatible report between two sets.
export * from "./wire-compat.js";

// Chains, their rpc endpoints, their explorers and their CCTP domains.
export * from "./chains.js";

// Pricing a route locally so an app can render four of them while somebody types.
export * from "./quotes.js";
// Why a local quote came out the way it did: checks with their owning policy, and exact derivations.
export * from "./quotes/explain.js";
export * from "./route-health.js";

// Reading a token registration diagnostic, which both chains answer in the same shape.
export * from "./tokenMapping.js";

// Deployment records, and a loader that checks them instead of casting them.
export * from "./deployments.js";

// Assets and rail contracts per chain, with provenance attached.
export * from "./registry/index.js";
