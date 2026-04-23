import test from "node:test";
import assert from "node:assert";
import {
  createUnsupportedHostUiIssue,
  createUnsupportedHostUiError,
  parseUnsupportedHostUiErrorMessage,
  serializeUnsupportedHostUiIssue,
  genericUnsupportedCapabilityMessage,
  commandUnsupportedCapabilityMessage,
} from "./unsupported-host-ui.ts";

test("unsupported-host-ui", async (t) => {
  await t.test("createUnsupportedHostUiIssue", () => {
    const issue = createUnsupportedHostUiIssue("custom");
    assert.strictEqual(issue.capability, "custom");
    assert.strictEqual(issue.classification, "terminal-only");
    assert.ok(issue.message.includes("custom UI"));
  });

  await t.test("createUnsupportedHostUiError", () => {
    const error = createUnsupportedHostUiError("onTerminalInput");
    assert.ok(error instanceof Error);
    assert.ok(error.message.startsWith("__PI_GUI_UNSUPPORTED_HOST_UI__:"));
    assert.ok(error.message.includes('"capability":"onTerminalInput"'));
  });

  await t.test("parseUnsupportedHostUiErrorMessage", async (t) => {
    await t.test("returns undefined for message without prefix", () => {
      assert.strictEqual(parseUnsupportedHostUiErrorMessage("plain message"), undefined);
    });

    await t.test("returns parsed issue for valid JSON with prefix", () => {
      const issue = {
        capability: "setEditorComponent",
        classification: "terminal-only" as const,
        message: "some message",
      };
      const serialized = serializeUnsupportedHostUiIssue(issue);
      assert.deepStrictEqual(parseUnsupportedHostUiErrorMessage(serialized), issue);
    });

    await t.test("returns undefined for invalid JSON with prefix", () => {
      // This specifically tests the catch block in parseUnsupportedHostUiErrorMessage
      const message = "__PI_GUI_UNSUPPORTED_HOST_UI__:invalid-json";
      assert.strictEqual(parseUnsupportedHostUiErrorMessage(message), undefined);
    });
  });

  await t.test("serializeUnsupportedHostUiIssue", () => {
    const issue = {
      capability: "setFooter",
      classification: "terminal-only" as const,
      message: "footer msg",
    };
    const serialized = serializeUnsupportedHostUiIssue(issue);
    assert.strictEqual(serialized, '__PI_GUI_UNSUPPORTED_HOST_UI__:{"capability":"setFooter","classification":"terminal-only","message":"footer msg"}');
  });

  await t.test("genericUnsupportedCapabilityMessage", () => {
    assert.strictEqual(
      genericUnsupportedCapabilityMessage("setHeader"),
      "Terminal-only header UI is not supported in pi-gui. Use pi in the terminal for that workflow."
    );
    assert.strictEqual(
      genericUnsupportedCapabilityMessage("unknownCap"),
      "Terminal-only unknown cap is not supported in pi-gui. Use pi in the terminal for that workflow."
    );
  });

  await t.test("commandUnsupportedCapabilityMessage", () => {
    assert.strictEqual(
      commandUnsupportedCapabilityMessage("test-cmd", "custom"),
      "/test-cmd requires terminal-only custom UI and is not supported in pi-gui yet. Use pi in the terminal for this command."
    );
  });
});
