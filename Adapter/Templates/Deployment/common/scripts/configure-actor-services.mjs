import { readFile, writeFile } from "node:fs/promises";

const beginMarker = "/* SWIFTWEB_EXTERNAL_ACTOR_BINDINGS_BEGIN */";
const endMarker = "/* SWIFTWEB_EXTERNAL_ACTOR_BINDINGS_END */";
const configurationPath = new URL("../swiftweb-actor-services.json", import.meta.url);
const wranglerPath = new URL("../wrangler.jsonc", import.meta.url);

const services = JSON.parse(await readFile(configurationPath, "utf8"));
const wrangler = await readFile(wranglerPath, "utf8");
const begin = wrangler.indexOf(beginMarker);
const end = wrangler.indexOf(endMarker);
const declarations = services.map((service) => {
  const configuration = service.configuration;
  for (const key of ["bindingName", "className", "scriptName"]) {
    if (typeof configuration[key] !== "string" || configuration[key].length === 0) {
      throw new Error(`Actor service '${service.service}' has no ${key}`);
    }
  }
  return {
    name: configuration.bindingName,
    class_name: configuration.className,
    script_name: configuration.scriptName,
  };
});

const names = new Set();
for (const declaration of declarations) {
  if (names.has(declaration.name)) {
    throw new Error(`Duplicate actor service binding '${declaration.name}'`);
  }
  names.add(declaration.name);
}

if (begin < 0 || end < begin) {
  verifyMaterializedBindings(wrangler, declarations);
} else {
  const before = wrangler.slice(0, begin + beginMarker.length);
  const after = wrangler.slice(end);
  const previousText = wrangler.slice(0, begin).trimEnd();
  const needsLeadingComma = declarations.length > 0 && !previousText.endsWith("[");
  const body = declarations.length === 0
    ? "\n      "
    : `${needsLeadingComma ? "," : ""}\n${declarations
        .map((value) => `      ${JSON.stringify(value)}`)
        .join(",\n")}\n      `;
  const output = before + body + after;
  if (output !== wrangler) {
    await writeFile(wranglerPath, output);
  }
}

function verifyMaterializedBindings(source, declarations) {
  const configuration = JSON.parse(stripTrailingCommas(stripJSONComments(source)));
  const bindings = configuration?.durable_objects?.bindings;
  if (!Array.isArray(bindings)) {
    throw new Error("Wrangler Durable Object bindings are missing");
  }
  for (const declaration of declarations) {
    const matches = bindings.filter((binding) => binding?.name === declaration.name);
    if (matches.length !== 1) {
      throw new Error(
        `Wrangler actor binding '${declaration.name}' must appear exactly once`,
      );
    }
    const binding = matches[0];
    if (binding.class_name !== declaration.class_name
        || binding.script_name !== declaration.script_name) {
      throw new Error(`Wrangler actor binding '${declaration.name}' does not match the service`);
    }
  }
}

function stripJSONComments(source) {
  let output = "";
  let inString = false;
  let escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    const next = source[index + 1];
    if (inString) {
      output += character;
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === "\"") {
        inString = false;
      }
      continue;
    }
    if (character === "\"") {
      inString = true;
      output += character;
      continue;
    }
    if (character === "/" && next === "/") {
      while (index < source.length && source[index] !== "\n") {
        index += 1;
      }
      output += "\n";
      continue;
    }
    if (character === "/" && next === "*") {
      index += 2;
      while (index < source.length
          && !(source[index] === "*" && source[index + 1] === "/")) {
        output += source[index] === "\n" ? "\n" : " ";
        index += 1;
      }
      index += 1;
      continue;
    }
    output += character;
  }
  return output;
}

function stripTrailingCommas(source) {
  let output = "";
  let inString = false;
  let escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (inString) {
      output += character;
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === "\"") {
        inString = false;
      }
      continue;
    }
    if (character === "\"") {
      inString = true;
      output += character;
      continue;
    }
    if (character === ",") {
      let lookahead = index + 1;
      while (/\s/.test(source[lookahead] ?? "")) {
        lookahead += 1;
      }
      if (source[lookahead] === "]" || source[lookahead] === "}") {
        continue;
      }
    }
    output += character;
  }
  return output;
}
