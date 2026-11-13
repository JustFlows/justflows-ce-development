import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { inertPreviewHandlers } from "../../../src/components/builder/inert-preview";

describe("inert previews", () => {
  it("cancels link navigation and form submission inside previews but not in builder chrome", () => {
    const { getByText, container } = render(
      <div {...inertPreviewHandlers}>
        <a href="https://example.com/">public link</a>
        <form>
          <button type="submit">Send</button>
        </form>
        <div data-builder-chrome="true">
          <a href="/admin/help">editor link</a>
        </div>
      </div>,
    );
    expect(fireEvent.click(getByText("public link"))).toBe(false);
    expect(fireEvent.click(getByText("editor link"))).toBe(true);
    expect(fireEvent.submit(container.querySelector("form")!)).toBe(false);
  });
});
