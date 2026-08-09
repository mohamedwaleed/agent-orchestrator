import { afterEach, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createHttpServer } from "./http-server.js";

describe("GET /products", () => {
  let server: Server | undefined;

  afterEach(async () => {
    if (server?.listening) {
      await new Promise<void>((resolve, reject) => {
        server!.close((error) => error ? reject(error) : resolve());
      });
    }
  });

  it("returns the three products in the store", async () => {
    server = createHttpServer();
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;

    const response = await fetch(`http://127.0.0.1:${port}/products`);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(body).toHaveLength(3);
    expect(body).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: expect.any(Number), name: expect.any(String), price: expect.any(Number) }),
    ]));
  });
});
