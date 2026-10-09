import { createApp } from "./app.js";

const port = Number(process.env.PORT ?? 3000);

createApp().listen(port, () => {
  console.log(`itera-agent-credentials-api listening on port ${port}`);
});
