const idInstance = process.env.GREEN_API_ID_INSTANCE;
const token = process.env.GREEN_API_TOKEN_INSTANCE;
const webhookUrl = process.env.GREEN_API_WEBHOOK_URL;

if (!idInstance || !token || !webhookUrl) {
  console.error("Missing GREEN_API_ID_INSTANCE, GREEN_API_TOKEN_INSTANCE, or GREEN_API_WEBHOOK_URL");
  process.exit(1);
}

const url = `https://api.green-api.com/waInstance${idInstance}/setSettings/${token}`;
const response = await fetch(url, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    webhookUrl,
    incomingWebhook: "yes",
    outgoingWebhook: "no",
    stateWebhook: "no",
  }),
});

const text = await response.text();
if (!response.ok) {
  console.error(text);
  process.exit(1);
}

console.log(text);
