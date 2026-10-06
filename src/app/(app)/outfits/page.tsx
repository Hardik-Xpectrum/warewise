import OutfitsView from "./OutfitsView";

export const metadata = { title: "Outfits · Warewise" };

/** `?favorites=1` (the header's heart icon) opens straight on favourites. */
export default async function OutfitsPage({ searchParams }: PageProps<"/outfits">) {
  const favorites = (await searchParams).favorites !== undefined;
  return <OutfitsView key={String(favorites)} initialFavorites={favorites} />;
}
