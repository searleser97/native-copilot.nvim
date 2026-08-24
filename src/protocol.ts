import { createInterface, type Interface } from "node:readline";
import { stdin, stdout } from "node:process";
import { randomUUID } from "node:crypto";
import { PROTOCOL_VERSION, type ProtocolMessage } from "./types.js";

export interface IncomingCommand {
  v: number;
  id: string;
  type: string;
  payload?: unknown;
}

export class Protocol {
  private readonly input: Interface;
  private closed = false;
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly onCommand: (command: IncomingCommand) => Promise<void>,
    private readonly onEof: () => Promise<void>,
  ) {
    this.input = createInterface({ input: stdin, crlfDelay: Infinity });
  }

  start(): void {
    this.input.on("line", (line) => {
      this.queue = this.queue.then(() => this.handleLine(line));
    });
    this.input.once("close", () => {
      void this.queue.then(async () => {
        if (!this.closed) {
          await this.onEof();
        }
      });
    });
  }

  private async handleLine(line: string): Promise<void> {
    if (line.trim() === "") {
      return;
    }
    let command: IncomingCommand;
    try {
      const parsed: unknown = JSON.parse(line);
      if (
        typeof parsed !== "object" ||
        parsed === null ||
        !("type" in parsed) ||
        typeof parsed.type !== "string" ||
        !("id" in parsed) ||
        typeof parsed.id !== "string" ||
        !("v" in parsed) ||
        typeof parsed.v !== "number"
      ) {
        throw new Error("expected an object with numeric v and string id/type fields");
      }
      command = parsed as IncomingCommand;
    } catch (error) {
      this.send("protocol.error", {
        message: `Invalid NDJSON command: ${error instanceof Error ? error.message : String(error)}`,
      });
      return;
    }
    if (command.v !== PROTOCOL_VERSION) {
      this.send(
        "protocol.error",
        {
          message: `Unsupported protocol version ${command.v}; expected ${PROTOCOL_VERSION}`,
        },
        { requestId: command.id },
      );
      return;
    }
    try {
      await this.onCommand(command);
    } catch (error) {
      this.send(
        "request.error",
        { message: error instanceof Error ? error.message : String(error) },
        { requestId: command.id },
      );
    }
  }

  send(
    type: string,
    payload?: unknown,
    fields: Omit<Partial<ProtocolMessage>, "v" | "id" | "type" | "ts" | "payload"> = {},
  ): ProtocolMessage {
    const message: ProtocolMessage = {
      v: PROTOCOL_VERSION,
      id: randomUUID(),
      type,
      ts: new Date().toISOString(),
      ...fields,
    };
    if (payload !== undefined) {
      message.payload = payload;
    }
    stdout.write(`${JSON.stringify(message)}\n`);
    return message;
  }

  stop(): void {
    this.closed = true;
    this.input.close();
  }
}
