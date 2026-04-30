import {
  compactToolResponse,
  normalizeToolError,
  structuredToolResponse,
  toolErrorResponse,
} from "../src/tools/response.js";

describe("tool response helpers", () => {
  it("returns text JSON and structured content for successful results", () => {
    const result = {
      entries: [],
      limit: 200,
      truncated: false,
    };

    expect(structuredToolResponse(result)).toEqual({
      content: [
        {
          type: "text",
          text: JSON.stringify(result, null, 2),
        },
      ],
      structuredContent: result,
    });
  });

  it("returns compact text with lean structured content", () => {
    expect(compactToolResponse("one\nline", { format: "compact", entries: 1 })).toEqual({
      content: [
        {
          type: "text",
          text: "one\nline",
        },
      ],
      structuredContent: {
        format: "compact",
        entries: 1,
      },
    });
  });

  it("returns concise MCP tool errors without stack traces", () => {
    const response = toolErrorResponse(new Error("Path '../x' resolves outside the configured workspace roots."));

    expect(response).toEqual({
      isError: true,
      content: [
        {
          type: "text",
          text: "Path '../x' resolves outside the configured workspace roots.",
        },
      ],
    });
    expect(response.content[0].text).not.toContain("Error:");
    expect(response.content[0].text).not.toContain("at ");
  });

  it("normalizes non-error throwables", () => {
    expect(normalizeToolError("invalid input").message).toBe("invalid input");
  });
});
