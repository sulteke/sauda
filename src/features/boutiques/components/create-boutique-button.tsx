"use client";

import { useState } from "react";
import { Plus } from "lucide-react";

import { Button } from "@/components/ui/button";
import { BoutiqueFormDialog } from "@/features/boutiques/components/boutique-form-dialog";

export function CreateBoutiqueButton() {
  const [open, setOpen] = useState(false);

  return (
    <BoutiqueFormDialog
      mode="create"
      open={open}
      onOpenChange={setOpen}
      trigger={
        <Button>
          <Plus className="h-4 w-4" />
          New boutique
        </Button>
      }
    />
  );
}
