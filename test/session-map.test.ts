import { describe, it, expect } from "vitest";
import { SessionMap } from "../src/slack/session-map.js";

describe("SessionMap", () => {
  it("stores and retrieves by session ID", () => {
    const map = new SessionMap();
    map.set("sess-1", { channelId: "C1", threadTs: "123.456", userId: "U1" });

    const info = map.getBySession("sess-1");
    expect(info?.channelId).toBe("C1");
    expect(info?.threadTs).toBe("123.456");
  });

  it("retrieves session ID by thread", () => {
    const map = new SessionMap();
    map.set("sess-1", { channelId: "C1", threadTs: "123.456", userId: "U1" });

    expect(map.getByThread("C1", "123.456")).toBe("sess-1");
    expect(map.getByThread("C1", "999.000")).toBeUndefined();
  });

  it("removes session and cleans up both indexes", () => {
    const map = new SessionMap();
    let cleanedUp = false;
    map.set("sess-1", {
      channelId: "C1",
      threadTs: "123.456",
      userId: "U1",
      cleanup: () => { cleanedUp = true; },
    });

    map.remove("sess-1");

    expect(map.getBySession("sess-1")).toBeUndefined();
    expect(map.getByThread("C1", "123.456")).toBeUndefined();
    expect(cleanedUp).toBe(true);
  });

  it("lists active sessions", () => {
    const map = new SessionMap();
    map.set("sess-1", { channelId: "C1", threadTs: "1", userId: "U1" });
    map.set("sess-2", { channelId: "C1", threadTs: "2", userId: "U2" });

    expect(map.activeSessions()).toEqual(["sess-1", "sess-2"]);
  });
});
