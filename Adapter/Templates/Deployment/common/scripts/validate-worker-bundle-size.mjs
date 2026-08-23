import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

const maximumCompressedBytes = readMaximumCompressedBytes(process.argv[2]);
const executableName = process.platform === "win32" ? "wrangler.cmd" : "wrangler";
const wrangler = join(process.cwd(), "node_modules", ".bin", executableName);

if (!existsSync(wrangler)) {
  throw new Error(`Wrangler executable is missing: ${wrangler}`);
}

const result = spawnSync(
  wrangler,
  [
    "deploy",
    "--dry-run",
    "--outdir",
    ".wrangler/deployment-validation",
    "--config",
    "wrangler.jsonc",
  ],
  {
    cwd: process.cwd(),
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    shell: process.platform === "win32",
  }
);

if (result.stdout) {
  process.stdout.write(result.stdout);
}
if (result.stderr) {
  process.stderr.write(result.stderr);
}
if (result.error) {
  throw result.error;
}
if (result.status !== 0) {
  process.exit(result.status ?? 1);
}

const output = removeTerminalFormatting(`${result.stdout ?? ""}\n${result.stderr ?? ""}`);
const compressedSize = readCompressedUploadSize(output);
if (compressedSize.upperBoundBytes > maximumCompressedBytes) {
  throw new Error(
    `Cloudflare Worker bundle cannot satisfy the compressed upload limit: rounded report upper bound ${compressedSize.upperBoundBytes} bytes > ${maximumCompressedBytes} bytes`
  );
}

console.log(
  `Validated complete Cloudflare Worker bundle: at most ${compressedSize.upperBoundBytes} compressed bytes from Wrangler's rounded report`
);

function readMaximumCompressedBytes(value) {
  const parsed = Number(value ?? 3 * 1024 * 1024);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new TypeError("Maximum compressed Worker bytes must be a positive integer");
  }
  return parsed;
}

function readCompressedUploadSize(output) {
  const match = output.match(
    /Total Upload:\s*[0-9]+(?:\.[0-9]+)?\s*[KMGT]?i?B\s*\/\s*gzip:\s*([0-9]+(?:\.[0-9]+)?)\s*([KMGT]?i?B)/i
  );
  if (!match) {
    throw new Error("Wrangler did not report the compressed Worker upload size");
  }
  const valueText = match[1];
  const value = Number(valueText);
  const fractionDigits = valueText.split(".")[1]?.length ?? 0;
  const roundingHalfStep = 0.5 * 10 ** -fractionDigits;
  return {
    upperBoundBytes: Math.ceil(
      (value + roundingHalfStep) * byteMultiplier(match[2])
    ),
  };
}

function byteMultiplier(unit) {
  const multipliers = {
    B: 1,
    KB: 1_000,
    MB: 1_000_000,
    GB: 1_000_000_000,
    TB: 1_000_000_000_000,
    KIB: 1_024,
    MIB: 1_048_576,
    GIB: 1_073_741_824,
    TIB: 1_099_511_627_776,
  };
  const multiplier = multipliers[unit.toUpperCase()];
  if (multiplier === undefined) {
    throw new Error(`Unsupported Wrangler upload size unit: ${unit}`);
  }
  return multiplier;
}

function removeTerminalFormatting(value) {
  return value.replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, "");
}
