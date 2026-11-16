#!/usr/bin/env node
/**
 * Isolated local Soroban activation rehearsal CLI.
 *
 * Runs the two-phase Stellar activation workflow (deploy, queue, early-execution rejection,
 * delayed execute, repeated phase-two idempotency check, peer link, and record verification)
 * in a deterministic local fixture environment without touching public RPC endpoints or keys.
 *
 * Output explicitly marks `evidenceKind: "local-fixture-rehearsal"` and
 * `signedTestnetAcceptance: false`.
 *
 * Usage:
 *   node script/stellar/rehearse-local.mjs [--input <config.json>] [--write-report <out.json>] [--json]
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const contractsRoot = resolve(here, "..", "..");

let protocol;
try {
  protocol = await import(resolve(contractsRoot, "packages/protocol/dist/index.js"));
} catch (cause) {
  throw new Error(
    "the protocol package is not built, so the local rehearsal cannot run. Run:\n" +
      "  cd packages/protocol && npm install && npm run build\n" +
      `(${String(cause)})`,
  );
}

const { runLocalStellarActivationRehearsal, formatRehearsalReport } = protocol;

function parseArgs(argv) {
  let inputPath = "";
  let writeReportPath = "";
  let json = false;
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--input") {
      inputPath = argv[i + 1] ?? "";
      i += 1;
    } else if (arg === "--write-report") {
      writeReportPath = argv[i + 1] ?? "";
      i += 1;
    } else if (arg === "--json") {
      json = true;
    } else {
      throw new Error(`unknown argument "${arg}"`);
    }
  }
  return { inputPath, writeReportPath, json };
}

const DEFAULT_REHEARSAL_INPUT = {
  chain: "stellar-testnet",
  router: "CCXPCT3YFLVANSF3AQMYCCZVGCMLTURAYQ6O6DYGQJMTKVYQL6NTOC2V",
  routerWasmHash: "a".repeat(64),
  deployer: "GDXRQQETEZHGRJTE3U7DYGIWGGYGMM6EAS5NWGPGN2WXFXZYZ6QZIANA",
  feeBps: 30,
  flowWindowLedgers: 720,
  timelockDelaySeconds: 3600,
  token: {
    code: "USDC",
    issuer: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
    sacId: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
    decimals: 7,
    flowLimit: "10000000000000",
  },
  axelar: {
    adapter: "CDFYEPIXO676W6E6Z4GOOR33JMRUC6DGUBGO4OWYKTO7HOGRJ6ARNOSJ",
    itsContract: "CC7LAC4S7KAPIM26WKWFSOXWLNLSG7EXTC2EVY2H2UPKSTX3Z2A7M5YP",
    wasmHash: "b".repeat(64),
    peerChain: "sepolia",
    axelarChainName: "ethereum-sepolia",
    peerHex20: "0".repeat(40),
    tokenIdHex32: "c".repeat(64),
  },
  cctp: {
    adapter: "CARH6IA4TA5QAJNQG4B4I7N4336JEBS3GYLPZSEBUCWSNYTDRC7L3AHT",
    tokenMessenger: "CDNG7HXAPBWICI2E3AUBP3YZWZELJLYSB6F5CC7WLDTLTHVM74SLRTHP",
    messageTransmitter: "CBJ6MTCKKZG73PMDZCJMSFRD7DQEMI4FKDH7CGDSV4W6FHCRBCQAVVJY",
    wasmHash: "d".repeat(64),
    peerChain: "sepolia",
    peerDomain: 0,
    destinationCallerHex32: "0".repeat(64),
    peerBurnTokenHex32: `0000000000000000000000001c7d4b196cb0c7b01d743fbc6116a902379c7238`,
  },
  interruptPhaseTwoAfterCount: 2,
};

const args = parseArgs(process.argv);
const rehearsalInput = args.inputPath
  ? JSON.parse(readFileSync(resolve(args.inputPath), "utf8"))
  : DEFAULT_REHEARSAL_INPUT;

const report = runLocalStellarActivationRehearsal(rehearsalInput);

if (args.writeReportPath) {
  const target = resolve(args.writeReportPath);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify(report, null, 2)}\n`);
}

if (args.json) {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} else {
  process.stdout.write(`${formatRehearsalReport(report)}\n`);
}

if (!report.healthy) {
  process.exit(1);
}
