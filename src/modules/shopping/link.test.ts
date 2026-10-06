import { describe, expect, it } from "vitest";
import { IMAGE_HOSTS, isAllowedUrl, parseProductMeta, SHOP_HOSTS } from "./link";

describe("isAllowedUrl", () => {
  it("accepts https links to known shops and their subdomains", () => {
    expect(isAllowedUrl("https://www.myntra.com/tshirts/roadster/123/buy", SHOP_HOSTS)?.hostname).toBe("www.myntra.com");
    expect(isAllowedUrl("https://ajio.com/p/1", SHOP_HOSTS)).not.toBeNull();
  });
  it("refuses anything that could reach other or internal addresses", () => {
    for (const bad of [
      "http://www.myntra.com/x", // not https
      "https://myntra.com.evil.example/x", // lookalike
      "https://evilmyntra.com/x",
      "https://user:pass@myntra.com/x",
      "https://myntra.com:8443/x",
      "https://169.254.169.254/latest/meta-data",
      "https://localhost/x",
      "javascript:alert(1)",
      "not a url",
    ]) expect(isAllowedUrl(bad, SHOP_HOSTS)).toBeNull();
  });
  it("allows shop image CDNs only in the image list", () => {
    expect(isAllowedUrl("https://assets.myntassets.com/a.jpg", SHOP_HOSTS)).toBeNull();
    expect(isAllowedUrl("https://assets.myntassets.com/a.jpg", IMAGE_HOSTS)).not.toBeNull();
  });
});

describe("parseProductMeta", () => {
  it("reads Open Graph tags in either attribute order", () => {
    const html = `<meta property="og:title" content="Roadster Men Navy Shirt &amp; Tie"><meta content="//assets.myntassets.com/s.jpg" property="og:image"><meta property="product:price:amount" content="899">`;
    expect(parseProductMeta(html, "https://www.myntra.com/p")).toEqual({ title: "Roadster Men Navy Shirt & Tie", image: "https://assets.myntassets.com/s.jpg", price: "899" });
  });
  it("falls back to schema.org Product JSON-LD", () => {
    const html = `<title>Shop</title><script type="application/ld+json">{"@type":"Product","name":"Linen Kurta","image":["https://cdn.shopify.com/k.jpg"],"offers":{"price":1499}}</script>`;
    expect(parseProductMeta(html, "https://www.fabindia.com/p")).toEqual({ title: "Linen Kurta", image: "https://cdn.shopify.com/k.jpg", price: "1499" });
  });
  it("uses the page title when nothing else is there", () => {
    expect(parseProductMeta("<title>Just a page</title>", "https://ajio.com/")).toEqual({ title: "Just a page", image: null, price: null });
  });
});
