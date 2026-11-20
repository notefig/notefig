import base from "./playwright.config";
export default {
  ...base,
  use: { ...base.use, baseURL: "http://localhost:1433" },
  webServer: { ...base.webServer, command: "true", url: "http://localhost:1433", reuseExistingServer: true },
};
