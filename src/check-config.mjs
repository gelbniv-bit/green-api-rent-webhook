const required = [
  "AIRTABLE_TOKEN",
  "GREEN_API_ID_INSTANCE",
  "GREEN_API_TOKEN_INSTANCE",
];

const missing = required.filter((name) => !process.env[name]);

if (missing.length) {
  console.error(`Missing env vars: ${missing.join(", ")}`);
  process.exit(1);
}

console.log("Config OK");
