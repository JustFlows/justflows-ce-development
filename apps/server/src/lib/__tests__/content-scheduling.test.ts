// SPDX-License-Identifier: MIT

import { describe, expect, it, vi } from "vitest";
vi.mock("../plugin-runtime.js", () => ({ getRuntimeHooks: () => ({}) }));
import { ContentScheduleSchema, dueTransition, scheduleError } from "../content-scheduling-db.js";
import { PatchContentSchema } from "../content-write.js";
const time = Date.parse("2030-06-01T10:00:00Z");

describe("schedule validation", () => {
  it("requires an explicit timezone and optimistic version", () => {
    expect(
      ContentScheduleSchema.safeParse({
        publishOn: "2030-06-01T12:00:00",
        unpublishOn: null,
        expectedVersion: 1,
      }).success,
    ).toBe(false);
    expect(
      ContentScheduleSchema.safeParse({
        publishOn: "2030-06-01T12:00:00+02:00",
        unpublishOn: null,
        expectedVersion: 1,
      }).success,
    ).toBe(true);
    expect(ContentScheduleSchema.safeParse({ publishOn: null, unpublishOn: null }).success).toBe(
      false,
    );
  });
  it("compares offset dates as instants and rejects reversed windows", () => {
    expect(
      scheduleError(
        {
          publishOn: "2030-06-01T14:00:00+02:00",
          unpublishOn: "2030-06-01T11:00:00Z",
          expectedVersion: 1,
        },
        "draft",
        time,
      ),
    ).toMatch(/after/);
    expect(
      scheduleError(
        { publishOn: "2030-06-01T12:00:00+02:00", unpublishOn: null, expectedVersion: 1 },
        "draft",
        time,
      ),
    ).toMatch(/future/);
  });
  it("allows expiry alone only for live content and permits cancellation", () => {
    const input = { publishOn: null, unpublishOn: "2030-06-01T11:00:00Z", expectedVersion: 1 };
    expect(scheduleError(input, "draft", time)).toMatch(/requires/);
    expect(scheduleError(input, "published", time)).toBeNull();
    expect(scheduleError({ ...input, unpublishOn: null }, "scheduled", time)).toBeNull();
  });
  it("does not allow PATCH to bypass the scheduling endpoint", () => {
    expect(PatchContentSchema.safeParse({ status: "scheduled" }).success).toBe(false);
  });
});
describe("due transitions", () => {
  it("does not publish early, and expires an entirely missed window", () => {
    const row = {
      status: "scheduled",
      publish_on: "2030-06-01 10:00:00",
      unpublish_on: "2030-06-01 11:00:00",
    };
    expect(dueTransition(row, time - 1)).toBeNull();
    expect(dueTransition(row, time)).toBe("publish");
    expect(dueTransition(row, time + 3_600_000)).toBe("expire");
    expect(dueTransition({ ...row, status: "published" }, time + 3_600_000)).toBe("unpublish");
    expect(dueTransition({ ...row, trashed_at: "2030-06-01 09:00:00" }, time)).toBeNull();
  });
});
