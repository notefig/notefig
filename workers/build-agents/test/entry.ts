// The Worker as tests run it: the real one, with `TestIssueAgent` as its Durable Object class.
export { default, GitGateway, RegistryGateway } from "../src/index.ts";
export { TestIssueAgent as IssueAgent } from "./issue-agent.ts";
