"use strict";

let _ajv = null;
function getAjv() {
  if (!_ajv) {
    const Ajv2020 = require("ajv/dist/2020").default;
    _ajv = new Ajv2020({
      allErrors: true,
      strict: true,
      validateFormats: false,
    });
  }
  return _ajv;
}

const MAX_SCHEMA_DEPTH = 8;
const MAX_SCHEMA_NODES = 256;
const MAX_ENUM_ITEMS = 256;
const MAX_PROPERTY_NAME_LENGTH = 128;
const FORBIDDEN_PROPERTY_NAMES = new Set(["__proto__", "constructor", "prototype"]);
const ALLOWED_TYPES = new Set(["array", "boolean", "integer", "null", "number", "object", "string"]);
const ALLOWED_KEYWORDS = new Set([
  "additionalProperties",
  "const",
  "enum",
  "items",
  "maxItems",
  "maxLength",
  "maximum",
  "minItems",
  "minLength",
  "minimum",
  "properties",
  "required",
  "type",
  "writeOnly",
]);

function isPlainRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertSafeName(name, label) {
  if (typeof name !== "string" || name.length < 1 || name.length > MAX_PROPERTY_NAME_LENGTH
    || FORBIDDEN_PROPERTY_NAMES.has(name) || name.includes("\0")) {
    throw new TypeError(`${label} is invalid`);
  }
}

function assertIntegerKeyword(schema, name) {
  if (schema[name] === undefined) return;
  if (!Number.isSafeInteger(schema[name]) || schema[name] < 0) {
    throw new TypeError(`Restricted setting schema ${name} must be a non-negative safe integer`);
  }
}

function assertNumberKeyword(schema, name) {
  if (schema[name] === undefined) return;
  if (typeof schema[name] !== "number" || !Number.isFinite(schema[name])) {
    throw new TypeError(`Restricted setting schema ${name} must be finite`);
  }
}

function assertRestrictedJsonSchema(root, options = {}) {
  const rootType = options.rootType ?? null;
  const stack = [{ schema: root, depth: 0, label: "valueSchema" }];
  let nodes = 0;
  while (stack.length) {
    const current = stack.pop();
    if (!current || !isPlainRecord(current.schema)) {
      throw new TypeError("Restricted setting schemas must contain plain objects");
    }
    nodes += 1;
    if (nodes > MAX_SCHEMA_NODES || current.depth > MAX_SCHEMA_DEPTH) {
      throw new TypeError("Restricted setting schema is too complex");
    }
    const schema = current.schema;
    for (const keyword of Object.keys(schema)) {
      if (!ALLOWED_KEYWORDS.has(keyword)) {
        throw new TypeError(`Restricted setting schema keyword is not allowed: ${keyword}`);
      }
    }
    if (!ALLOWED_TYPES.has(schema.type)) {
      throw new TypeError("Every restricted setting schema node must declare one supported type");
    }
    if (current.depth === 0 && rootType && schema.type !== rootType) {
      throw new TypeError(`Restricted setting schema root must use type ${rootType}`);
    }
    if (schema.enum !== undefined) {
      if (!Array.isArray(schema.enum) || schema.enum.length < 1 || schema.enum.length > MAX_ENUM_ITEMS) {
        throw new TypeError("Restricted setting schema enum is invalid");
      }
    }
    assertIntegerKeyword(schema, "minItems");
    assertIntegerKeyword(schema, "maxItems");
    assertIntegerKeyword(schema, "minLength");
    assertIntegerKeyword(schema, "maxLength");
    assertNumberKeyword(schema, "minimum");
    assertNumberKeyword(schema, "maximum");
    if (schema.minItems !== undefined && schema.maxItems !== undefined && schema.minItems > schema.maxItems) {
      throw new TypeError("Restricted setting schema minItems exceeds maxItems");
    }
    if (schema.minLength !== undefined && schema.maxLength !== undefined && schema.minLength > schema.maxLength) {
      throw new TypeError("Restricted setting schema minLength exceeds maxLength");
    }
    if (schema.minimum !== undefined && schema.maximum !== undefined && schema.minimum > schema.maximum) {
      throw new TypeError("Restricted setting schema minimum exceeds maximum");
    }
    if (schema.type === "integer" && schema.minimum !== undefined && schema.maximum !== undefined
      && Math.ceil(schema.minimum) > Math.floor(schema.maximum)) {
      throw new TypeError("Restricted integer setting schema has no valid value");
    }
    if (schema.type === "array") {
      if (!isPlainRecord(schema.items)) throw new TypeError("Restricted array schemas require one items schema");
      stack.push({ schema: schema.items, depth: current.depth + 1, label: `${current.label}.items` });
    } else if (schema.items !== undefined || schema.minItems !== undefined || schema.maxItems !== undefined) {
      throw new TypeError("Restricted setting schema array keywords require type array");
    }
    if (schema.type === "object") {
      if (!isPlainRecord(schema.properties)) throw new TypeError("Restricted object schemas require properties");
      if (schema.additionalProperties !== false) {
        throw new TypeError("Restricted object schemas must set additionalProperties to false");
      }
      const propertyNames = Object.keys(schema.properties);
      for (const name of propertyNames) {
        assertSafeName(name, "Restricted setting schema property name");
        stack.push({ schema: schema.properties[name], depth: current.depth + 1, label: `${current.label}.${name}` });
      }
      if (schema.required !== undefined) {
        if (!Array.isArray(schema.required) || new Set(schema.required).size !== schema.required.length
          || schema.required.some((name) => typeof name !== "string" || !Object.hasOwn(schema.properties, name))) {
          throw new TypeError("Restricted object schema required fields are invalid");
        }
      }
    } else if (schema.properties !== undefined || schema.required !== undefined || schema.additionalProperties !== undefined) {
      throw new TypeError("Restricted setting schema object keywords require type object");
    }
    if (schema.type !== "string" && (schema.minLength !== undefined || schema.maxLength !== undefined)) {
      throw new TypeError("Restricted setting schema string keywords require type string");
    }
    if (!["integer", "number"].includes(schema.type) && (schema.minimum !== undefined || schema.maximum !== undefined)) {
      throw new TypeError("Restricted setting schema numeric keywords require type number or integer");
    }
  }
  return root;
}

function compileRestrictedJsonSchema(schema, options = {}) {
  assertRestrictedJsonSchema(schema, options);
  const ajv = getAjv();
  let validate;
  try { validate = ajv.compile(schema); }
  catch (error) { throw new TypeError(`Restricted setting schema is invalid: ${error?.message ?? error}`); }
  return (value) => {
    if (validate(value)) return true;
    const details = ajv.errorsText(validate.errors, { separator: "; " });
    throw new TypeError(`Value does not match its restricted setting schema: ${details}`);
  };
}

module.exports = {
  ALLOWED_KEYWORDS,
  MAX_SCHEMA_DEPTH,
  MAX_SCHEMA_NODES,
  assertRestrictedJsonSchema,
  compileRestrictedJsonSchema,
};
