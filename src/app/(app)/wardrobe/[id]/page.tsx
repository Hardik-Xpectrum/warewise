import ItemEditor from "./ItemEditor";

export const metadata = { title: "Item · Warewise" };

export default async function ItemPage(props: PageProps<"/wardrobe/[id]">) {
  const { id } = await props.params;
  return <ItemEditor id={id} />;
}
