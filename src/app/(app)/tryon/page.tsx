import TryOnStudio from "./TryOnStudio";

export const metadata = { title: "Try-on · Warewise" };

export default async function TryOnPage(props: PageProps<"/tryon">) {
  const { outfit, items } = await props.searchParams;
  // ?items=a,b,c comes from the Wardrobe fitting room; ?outfit= from outfit cards.
  const itemIds = typeof items === "string" ? items.split(",").filter(Boolean).slice(0, 8) : null;
  return <TryOnStudio initialOutfitId={typeof outfit === "string" ? outfit : null} initialItemIds={itemIds} />;
}
