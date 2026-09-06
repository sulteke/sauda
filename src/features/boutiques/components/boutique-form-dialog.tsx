"use client";

import type { ReactNode } from "react";
import { toast } from "sonner";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { BoutiqueForm } from "@/features/boutiques/components/boutique-form";
import type { BoutiqueInput } from "@/features/boutiques/schemas";
import { useCreateBoutique, useUpdateBoutique } from "@/hooks/use-boutiques";
import type { BoutiqueDTO } from "@/types";

interface BoutiqueFormDialogProps {
  mode: "create" | "edit";
  boutique?: BoutiqueDTO;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  trigger?: ReactNode;
}

export function BoutiqueFormDialog({
  mode,
  boutique,
  open,
  onOpenChange,
  trigger,
}: BoutiqueFormDialogProps) {
  const createMutation = useCreateBoutique();
  const updateMutation = useUpdateBoutique();
  const isSubmitting = createMutation.isPending || updateMutation.isPending;

  async function handleSubmit(values: BoutiqueInput) {
    try {
      if (mode === "create") {
        await createMutation.mutateAsync(values);
        toast.success("Boutique created");
      } else if (boutique) {
        await updateMutation.mutateAsync({ id: boutique.id, input: values });
        toast.success("Boutique updated");
      }
      onOpenChange(false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Something went wrong");
    }
  }

  const defaultValues: Partial<BoutiqueInput> | undefined = boutique
    ? {
        name: boutique.name,
        slug: boutique.slug,
        city: boutique.city ?? "",
        description: boutique.description ?? "",
        status: boutique.status,
        telegramQueued: boutique.telegramQueued,
      }
    : undefined;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {trigger ? <DialogTrigger asChild>{trigger}</DialogTrigger> : null}
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{mode === "create" ? "New boutique" : "Edit boutique"}</DialogTitle>
          <DialogDescription>
            {mode === "create"
              ? "Add a boutique to the system."
              : "Update this boutique's details."}
          </DialogDescription>
        </DialogHeader>
        <BoutiqueForm
          defaultValues={defaultValues}
          onSubmit={handleSubmit}
          isSubmitting={isSubmitting}
          submitLabel={mode === "create" ? "Create boutique" : "Save changes"}
        />
      </DialogContent>
    </Dialog>
  );
}
