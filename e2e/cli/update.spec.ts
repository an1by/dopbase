import { once } from "node:events";
import { createServer, type Server } from "node:net";
import { about, expect, step, test, useServer } from "../harness/index.ts";

const app = useServer();

/**
 * A local HTTPS proxy that refuses every CONNECT and records it. Pointing
 * HTTPS_PROXY at it keeps `dopbase update` off the network while showing
 * whether it tried to reach GitHub.
 */
async function refusingProxy(): Promise<{
  url: string;
  requests: string[];
  close: () => Promise<void>;
}> {
  const requests: string[] = [];
  const server: Server = createServer((socket) => {
    socket.once("data", (data) => {
      requests.push(data.toString().split("\r\n")[0]!);
      socket.end("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n");
    });
    socket.on("error", () => {});
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise((done) => server.close(() => done())),
  };
}

test(
  "update fails with a clear message when GitHub can't be reached",
  {
    annotation: about(
      "`dopbase update` behind a proxy that refuses the connection exits 1 and says the release check failed; the run never leaves this machine.",
    ),
  },
  async () => {
    const proxy = await refusingProxy();
    try {
      const result = await step(
        "HTTPS_PROXY=<local refusing proxy> dopbase update",
        async () =>
          app
            .cliRaw(["update"], {
              env: {
                HOME: app.server.root,
                HTTPS_PROXY: proxy.url,
                https_proxy: proxy.url,
              },
            })
            .fails(1),
      );
      await step("It says it failed to query the latest release", async () => {
        expect(result.stderr).toContain(
          "failed to query the latest Dopbase release",
        );
      });
      await step(
        "The only request was a CONNECT to api.github.com, stopped locally",
        async () => {
          expect(proxy.requests).toEqual([
            "CONNECT api.github.com:443 HTTP/1.1",
          ]);
        },
      );
    } finally {
      await proxy.close();
    }
  },
);

test(
  "update checks GitHub even with DOPBASE_UPDATE_CHECK off",
  {
    annotation: about(
      "DOPBASE_UPDATE_CHECK only controls the server's own release check for the Status page. `dopbase update` is a check you ask for, so it still goes to api.github.com with the setting off (docs/cli/commands.md).",
    ),
  },
  async () => {
    const proxy = await refusingProxy();
    try {
      const result = await step(
        "DOPBASE_UPDATE_CHECK=false HTTPS_PROXY=<local refusing proxy> dopbase update",
        async () =>
          app
            .cliRaw(["update"], {
              env: {
                HOME: app.server.root,
                DOPBASE_UPDATE_CHECK: "false",
                HTTPS_PROXY: proxy.url,
                https_proxy: proxy.url,
              },
            })
            .fails(1),
      );
      await step("It tried GitHub and says the check failed", async () => {
        expect(result.stderr).toContain(
          "failed to query the latest Dopbase release",
        );
        expect(proxy.requests).toEqual(["CONNECT api.github.com:443 HTTP/1.1"]);
      });
    } finally {
      await proxy.close();
    }
  },
);
