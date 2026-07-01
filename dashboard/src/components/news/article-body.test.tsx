import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ArticleBody } from "./article-body";

const html = (body: string) => renderToStaticMarkup(<ArticleBody body={body} />);

describe("ArticleBody markdown subset", () => {
  it("splits paragraphs on blank lines", () => {
    const out = html("First paragraph.\n\nSecond paragraph.");
    expect(out).toContain("<p");
    expect(out.match(/<p/g)?.length).toBe(2);
  });

  it("renders bold, italic and links inline", () => {
    const out = html("A **bold** move, an *italic* aside, [a source](https://x.com/a).");
    expect(out).toContain("<strong>bold</strong>");
    expect(out).toContain("<em>italic</em>");
    expect(out).toContain('href="https://x.com/a"');
    expect(out).toContain('rel="noreferrer"');
  });

  it("renders ## subheads, blockquotes and lists", () => {
    const out = html(
      "## The Fed's Turn\n\n> Rates are a story.\n\n- one\n- two\n\n1. first\n2. second",
    );
    expect(out).toContain("The Fed&#x27;s Turn</h4>");
    expect(out).toContain("<blockquote");
    expect(out.match(/<li/g)?.length).toBe(4);
    expect(out).toContain("<ul");
    expect(out).toContain("<ol");
  });

  it("never interprets raw HTML — React escapes by construction", () => {
    const out = html('<script>alert("x")</script>');
    expect(out).not.toContain("<script>");
    expect(out).toContain("&lt;script&gt;");
  });

  it("renders nothing for an empty body", () => {
    expect(html("")).toBe("");
  });
});
