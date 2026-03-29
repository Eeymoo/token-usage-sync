"use strict";

const { createApp } = require("./src/server");
const { hashApiKey } = require("./src/api-key");

if (require.main === module) {
  const app = createApp();

  app.start().catch((error) => {
    console.error("Failed to start proxy:", error);
    process.exitCode = 1;
  });
}

module.exports = {
  createApp,
  hashApiKey,
};
