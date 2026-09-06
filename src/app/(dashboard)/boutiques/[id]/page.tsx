import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { BoutiqueDetails } from "@/features/boutiques/components/boutique-details";
import { getBoutiqueById } from "@/services/boutique.service";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Boutique",
};

export default async function BoutiqueDetailsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const boutique = await getBoutiqueById(id);

  if (!boutique) {
    notFound();
  }

  return <BoutiqueDetails boutique={boutique} />;
}
