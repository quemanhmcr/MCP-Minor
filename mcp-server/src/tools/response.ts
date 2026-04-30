export type ToolStructuredResult = Record<string, unknown>;
export type ToolOutputFormat = "compact" | "json";
export type LegacyToolOutputFormat = ToolOutputFormat;

export interface ToolSuccessResponse {
  [key: string]: unknown;
  content: [
    {
      type: "text";
      text: string;
    },
  ];
  structuredContent: ToolStructuredResult;
}

export interface ToolErrorResponse {
  [key: string]: unknown;
  isError: true;
  content: [
    {
      type: "text";
      text: string;
    },
  ];
}

export type ToolResponse = ToolSuccessResponse | ToolErrorResponse;

export function structuredToolResponse(result: ToolStructuredResult): ToolSuccessResponse {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(result, null, 2),
      },
    ],
    structuredContent: result,
  };
}

export function compactToolResponse(text: string, structuredContent: object): ToolSuccessResponse {
  return {
    content: [
      {
        type: "text",
        text,
      },
    ],
    structuredContent: structuredContent as ToolStructuredResult,
  };
}

export function chooseOutputFormat(format: ToolOutputFormat | undefined): ToolOutputFormat {
  return format ?? "compact";
}

export function toolErrorResponse(error: unknown, normalizeError: (error: unknown) => Error = normalizeToolError): ToolErrorResponse {
  const normalized = normalizeError(error);

  return {
    isError: true,
    content: [
      {
        type: "text",
        text: normalized.message,
      },
    ],
  };
}

export function normalizeToolError(error: unknown): Error {
  if (error instanceof Error) {
    return error;
  }

  return new Error(String(error));
}
