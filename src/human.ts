import { readState, writeState } from "./state.js";

export async function waitForHumanResponse(
  projectRoot: string,
  requestId: string,
  timeoutSeconds: number
): Promise<string> {
  const deadline = Date.now() + timeoutSeconds * 1000;

  while (Date.now() < deadline) {
    const state = readState(projectRoot);
    const request = state.humanRequests[requestId];
    if (!request) {
      throw new Error(`human request disappeared: ${requestId}`);
    }
    if (request.status === "answered" && request.response) {
      return request.response;
    }
    if (request.status === "cancelled" || request.status === "timed_out") {
      throw new Error(`human request ${request.status}: ${requestId}`);
    }
    await sleep(1000);
  }

  const state = readState(projectRoot);
  const request = state.humanRequests[requestId];
  if (request && request.status === "pending") {
    writeState({
      ...state,
      humanRequests: {
        ...state.humanRequests,
        [requestId]: {
          ...request,
          status: "timed_out"
        }
      }
    });
  }

  throw new Error(`need_human timed out after ${timeoutSeconds}s`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
