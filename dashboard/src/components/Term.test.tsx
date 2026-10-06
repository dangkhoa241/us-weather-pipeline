import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Term } from "@/components/Term";

const setup = () => {
  render(<p>Error (<Term k="MAE" />) and <button type="button">next</button></p>);
  const term = screen.getByText("MAE");
  return { term, tip: () => screen.queryByRole("tooltip") };
};

describe("Term", () => {
  it("is an <abbr> with a dotted underline, described by its tooltip", () => {
    const { term } = setup();
    expect(term.tagName).toBe("ABBR");
    expect(term).toHaveClass("underline", "decoration-dotted");
    expect(term).toHaveAttribute("tabindex", "0");
    const tip = document.getElementById(term.getAttribute("aria-describedby")!);
    expect(tip).toHaveAttribute("role", "tooltip");
    expect(term).toHaveAccessibleDescription("Mean absolute error: The average size of the forecast errors, ignoring whether they were too warm or too cold.");
  });

  it("opens on hover and closes when the mouse leaves", async () => {
    const user = userEvent.setup();
    const { term, tip } = setup();
    expect(tip()).toBeNull();
    await user.hover(term);
    expect(tip()).toHaveTextContent("Mean absolute error");
    await user.unhover(term);
    expect(tip()).toBeNull();
  });

  it("opens on keyboard focus and closes on Escape and on blur", async () => {
    const user = userEvent.setup();
    const { term, tip } = setup();
    await user.tab();
    expect(term).toHaveFocus();
    expect(tip()).toHaveTextContent("Mean absolute error");
    await user.keyboard("{Escape}");
    expect(tip()).toBeNull();
    expect(term).toHaveFocus();          // Escape only closes the tooltip
    await user.tab();                    // focus back on it, then away
    await user.tab({ shift: true });
    expect(tip()).not.toBeNull();
    await user.tab();
    expect(tip()).toBeNull();
  });

  it("opens on tap and closes on Escape even when opened by hover", async () => {
    const { term, tip } = setup();
    fireEvent.click(term);
    expect(tip()).not.toBeNull();
    fireEvent.blur(term);
    expect(tip()).toBeNull();
    fireEvent.mouseEnter(term);
    expect(tip()).not.toBeNull();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(tip()).toBeNull();
  });
});
