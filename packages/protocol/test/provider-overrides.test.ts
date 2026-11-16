import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  DEPLOYMENT_SCHEMA_VERSION,
  DeploymentFormatError,
  applyProviderOverrides,
  deploymentFor,
  parseDeploymentSet,
  providerContractsFor,
  tokenFor,
} from "../src/index.js";
import { C_ADDR } from "./fixtures.js";

const here = dirname(fileURLToPath(import.meta.url));
const phase1Path = resolve(here, "..", "..", "..", "deployments", "stellar-testnet-phase1.json");

const EVM_ADDR_A = "0x1111111111111111111111111111111111111111";
const EVM_ADDR_B = "0x2222222222222222222222222222222222222222";
const EVM_ADDR_C = "0x3333333333333333333333333333333333333333";

function sepoliaSet(extraNetworkFields: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: DEPLOYMENT_SCHEMA_VERSION,
    generatedAt: "2026-10-29T10:17:56.262Z",
    networks: {
      sepolia: {
        family: "evm",
        chainId: 11155111,
        router: EVM_ADDR_A,
        adapters: { cctp: EVM_ADDR_B, "axelar-its": EVM_ADDR_C },
        tokens: {
          USDC: {
            address: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
            decimals: 6,
            flowLimit: "1000000000000",
            routes: ["cctp", "axelar-its"],
          },
        },
        treasury: EVM_ADDR_A,
        admin: EVM_ADDR_A,
        guardian: EVM_ADDR_A,
        feeBps: 30,
        flowWindow: 3600,
        timelockDelay: 3600,
        deployedAt: {
          blockNumber: "7000000",
          timestamp: "2026-10-29T10:00:00.000Z",
          txHash: `0x${"ab".repeat(32)}`,
        },
        commit: "b91c6ca",
        ...extraNetworkFields,
      },
    },
  };
}

describe("validated provider-contract overrides in deployment parsing", () => {
  it("parses existing canonical deployment records unchanged and attaches valid provider overrides cleanly", () => {
    const rawPhase1 = JSON.parse(readFileSync(phase1Path, "utf8")) as unknown;
    const baselineParsed = parseDeploymentSet(rawPhase1);
    expect(providerContractsFor(baselineParsed, "stellar-testnet")).toBeNull();
    expect("providerContracts" in (baselineParsed.networks["stellar-testnet"] ?? {})).toBe(false);

    const overridden = applyProviderOverrides(baselineParsed, {
      "stellar-testnet": {
        cctp: {
          tokenMessengerMinter: C_ADDR,
          messageTransmitter: "CARH6IA4TA5QAJNQG4B4I7N4336JEBS3GYLPZSEBUCWSNYTDRC7L3AHT",
        },
        axelar: {
          chainName: "stellar-2026-q1-2",
          interchainTokenService: "CDFYEPIXO676W6E6Z4GOOR33JMRUC6DGUBGO4OWYKTO7HOGRJ6ARNOSJ",
          gasService: C_ADDR,
          gateway: null,
        },
      },
    });

    // Baseline object remains unmutated, and declared chain/token precision stay intact.
    expect(providerContractsFor(baselineParsed, "stellar-testnet")).toBeNull();
    expect(tokenFor(overridden, "stellar-testnet", "USDC")?.decimals).toBe(7);
    expect(deploymentFor(overridden, "stellar-testnet")?.chain).toBe("stellar-testnet");
    expect(providerContractsFor(overridden, "stellar-testnet")).toEqual({
      cctp: {
        tokenMessengerMinter: C_ADDR,
        messageTransmitter: "CARH6IA4TA5QAJNQG4B4I7N4336JEBS3GYLPZSEBUCWSNYTDRC7L3AHT",
      },
      axelar: {
        chainName: "stellar-2026-q1-2",
        interchainTokenService: "CDFYEPIXO676W6E6Z4GOOR33JMRUC6DGUBGO4OWYKTO7HOGRJ6ARNOSJ",
        gasService: C_ADDR,
        gateway: null,
      },
    });
  });

  it("rejects overrides attempting to alter declared chain identity, token precision, or endpoints", () => {
    expect(() =>
      parseDeploymentSet(sepoliaSet(), {
        providerOverrides: {
          sepolia: {
            chainId: 1,
          },
        },
      }),
    ).toThrow(DeploymentFormatError);

    try {
      parseDeploymentSet(sepoliaSet(), {
        providerOverrides: {
          sepolia: {
            decimals: 18,
          },
        },
      });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(DeploymentFormatError);
      expect((error as DeploymentFormatError).path).toBe("$.providerOverrides.sepolia.decimals");
    }

    try {
      parseDeploymentSet(sepoliaSet(), {
        providerOverrides: {
          sepolia: {
            rpcUrl: "https://rpc.sepolia.org",
          },
        },
      });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(DeploymentFormatError);
      expect((error as DeploymentFormatError).path).toBe("$.providerOverrides.sepolia.rpcUrl");
    }
  });

  it("produces field-specific errors for missing required provider pairs and unsupported capabilities", () => {
    // Missing messageTransmitterV2 in EVM CCTP pair/trio
    try {
      parseDeploymentSet(sepoliaSet(), {
        providerOverrides: {
          sepolia: {
            cctp: {
              tokenMessengerV2: EVM_ADDR_A,
              tokenMinterV2: EVM_ADDR_B,
            },
          },
        },
      });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(DeploymentFormatError);
      expect((error as DeploymentFormatError).path).toBe(
        "$.providerOverrides.sepolia.cctp.messageTransmitterV2",
      );
    }

    // Missing gatewayMinter in EVM Circle Gateway pair
    try {
      parseDeploymentSet(sepoliaSet(), {
        providerOverrides: {
          sepolia: {
            gateway: {
              gatewayWallet: EVM_ADDR_A,
            },
          },
        },
      });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(DeploymentFormatError);
      expect((error as DeploymentFormatError).path).toBe(
        "$.providerOverrides.sepolia.gateway.gatewayMinter",
      );
    }

    // Missing gasService in Axelar pair
    try {
      parseDeploymentSet(sepoliaSet(), {
        providerOverrides: {
          sepolia: {
            axelar: {
              chainName: "ethereum-sepolia",
              interchainTokenService: EVM_ADDR_A,
            },
          },
        },
      });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(DeploymentFormatError);
      expect((error as DeploymentFormatError).path).toBe(
        "$.providerOverrides.sepolia.axelar.gasService",
      );
    }

    // Arc mainnet has axelarName: null, so Axelar overrides fail capability validation.
    const arcSet = {
      schemaVersion: DEPLOYMENT_SCHEMA_VERSION,
      generatedAt: "2026-10-29T10:17:56.262Z",
      networks: {
        arc: {
          ...(sepoliaSet().networks as Record<string, Record<string, unknown>>).sepolia,
          chainId: 5042001,
          tokens: {
            USDC: {
              address: "0x3600000000000000000000000000000000000000",
              decimals: 6,
              flowLimit: "1000000000",
              routes: ["cctp"],
            },
          },
        },
      },
    };
    try {
      parseDeploymentSet(arcSet, {
        providerOverrides: {
          arc: {
            axelar: {
              chainName: "arc",
              interchainTokenService: EVM_ADDR_A,
              gasService: EVM_ADDR_B,
            },
          },
        },
      });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(DeploymentFormatError);
      expect((error as DeploymentFormatError).path).toBe("$.providerOverrides.arc.axelar");
    }
  });
});
