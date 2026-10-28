import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Connection, Keypair } from "@solana/web3.js";
import { boot, rpcUrl as appRpcUrl } from "@devagent/app";
import { systemClock } from "@devagent/core";
import { getAgent, listAgents } from "@devagent/db";
import {
  MockLaunchPad,
  buildCreateTx,
  buildSplitTx,
  defaultSplit,
  getLaunch,
  recordLaunch,
  submitSigned,
  type LaunchRequest,
} from "@devagent/launch";

// Operator command. Nothing here signs: transactions are written to disk, signed with the operator's own wallet,
// then submitted. See DECISIONS D15 for why the fee split must be confirmed first.
//   launch mock <agent>
//   launch prepare <agent> --creator W --treasury W --deployer W --infra W --buyback W [--name N --symbol S --uri U]
//   launch prepare-split <agent> --mint M (same wallet flags)
//   launch submit <signed.b64>
//   launch record <agent> --mint M --signature SIG
const [cmd, first, ...rest] = process.argv.slice(2);
const flag = (n: string, d?: string) => {
  const i = rest.indexOf(`--${n}`);
  const v = i >= 0 ? rest[i + 1] : d;
  if (v === undefined) throw new Error(`missing --${n}`);
  return v;
};
const app = boot();
const agentId = () => {
  const a = first && (getAgent(app.db, first) ?? listAgents(app.db).find((x) => x.name === first));
  if (!a) throw new Error(`unknown agent ${first}`);
  return a.id;
};
const rpcUrl = () => appRpcUrl(app);
const request = (id: string): LaunchRequest => {
  const a = getAgent(app.db, id)!;
  return {
    name: flag("name", a.name).slice(0, 32),
    symbol: flag(
      "symbol",
      a.name
        .replace(/[^A-Za-z0-9]/g, "")
        .slice(0, 10)
        .toUpperCase() || "AGENT",
    ),
    uri: flag("uri", "https://example.com/metadata.json"),
    creator: flag("creator"),
    split: defaultSplit({
      agent_treasury: flag("treasury"),
      infra: flag("infra"),
      deployer: flag("deployer"),
      buyback: flag("buyback"),
    }),
  };
};
try {
  if (cmd === "mock") {
    const id = agentId();
    const w = () => Keypair.generate().publicKey.toBase58();
    const split = defaultSplit({ agent_treasury: w(), deployer: w(), infra: w(), buyback: w() });
    const r = await new MockLaunchPad().launch({
      name: "Mock Agent",
      symbol: "MOCK",
      uri: "https://example.com/m.json",
      creator: split[2]!.address,
      split,
    });
    recordLaunch(app.db, systemClock, {
      agentId: id,
      mint: r.mint,
      cluster: "mock",
      signature: r.signature,
      split,
    });
    console.log(JSON.stringify(getLaunch(app.db, id), null, 2));
  } else if (cmd === "prepare" || cmd === "prepare-split") {
    const id = agentId();
    const rpc = new Connection(rpcUrl(), "confirmed");
    const dir = join("data", "launch", id);
    mkdirSync(dir, { recursive: true });
    const req = request(id);
    if (cmd === "prepare") {
      const { mint, tx } = await buildCreateTx(rpc, app.config.solanaCluster, req);
      writeFileSync(join(dir, "create.unsigned.b64"), tx);
      console.log(
        `mint ${mint}\nwrote ${join(dir, "create.unsigned.b64")}\nSign it with the creator wallet, then: pnpm launch submit <signed file>`,
      );
    } else {
      const { tx } = await buildSplitTx(rpc, app.config.solanaCluster, req, flag("mint"));
      writeFileSync(join(dir, "split.unsigned.b64"), tx);
      console.log(
        `wrote ${join(dir, "split.unsigned.b64")}\nTHE SPLIT CAN BE SET ONLY ONCE. Check every address and share before signing.`,
      );
    }
  } else if (cmd === "submit") {
    console.log(
      await submitSigned(
        new Connection(rpcUrl(), "confirmed"),
        readFileSync(first!, "utf8").trim(),
      ),
    );
  } else if (cmd === "record") {
    recordLaunch(app.db, systemClock, {
      agentId: agentId(),
      mint: flag("mint"),
      cluster: app.config.solanaCluster,
      signature: flag("signature"),
      split: [],
    });
    console.log("recorded");
  } else
    console.log(
      "usage: launch mock|prepare|prepare-split|submit|record (see apps/cli/src/launch.ts)",
    );
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
} finally {
  app.close();
}
