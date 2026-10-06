import BodyScan from "@/components/BodyScan";

export const metadata = { title: "360° body scan · Warewise" };

export default function ScanPage() {
  return (
    <div className="mx-auto max-w-2xl">
      <BodyScan />
    </div>
  );
}
