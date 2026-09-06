"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { Controller, useForm } from "react-hook-form";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
  BOUTIQUE_STATUS_LABELS,
  BOUTIQUE_STATUSES,
  boutiqueInputSchema,
  type BoutiqueInput,
} from "@/features/boutiques/schemas";

interface BoutiqueFormProps {
  defaultValues?: Partial<BoutiqueInput>;
  onSubmit: (values: BoutiqueInput) => void | Promise<void>;
  isSubmitting?: boolean;
  submitLabel?: string;
}

const EMPTY_VALUES: BoutiqueInput = {
  name: "",
  slug: "",
  city: "",
  description: "",
  status: "DRAFT",
  telegramQueued: false,
};

export function BoutiqueForm({
  defaultValues,
  onSubmit,
  isSubmitting = false,
  submitLabel = "Save",
}: BoutiqueFormProps) {
  const {
    register,
    handleSubmit,
    control,
    formState: { errors },
  } = useForm<BoutiqueInput>({
    resolver: zodResolver(boutiqueInputSchema),
    defaultValues: { ...EMPTY_VALUES, ...defaultValues },
  });

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="name">Name</Label>
        <Input id="name" placeholder="Boutique name" {...register("name")} />
        {errors.name ? <p className="text-sm text-destructive">{errors.name.message}</p> : null}
      </div>

      <div className="space-y-2">
        <Label htmlFor="slug">Slug</Label>
        <Input id="slug" placeholder="auto-generated from name if empty" {...register("slug")} />
        {errors.slug ? <p className="text-sm text-destructive">{errors.slug.message}</p> : null}
      </div>

      <div className="space-y-2">
        <Label htmlFor="city">City</Label>
        <Input id="city" placeholder="Almaty" {...register("city")} />
        {errors.city ? <p className="text-sm text-destructive">{errors.city.message}</p> : null}
      </div>

      <div className="space-y-2">
        <Label htmlFor="description">Description</Label>
        <Textarea
          id="description"
          rows={3}
          placeholder="Optional notes"
          {...register("description")}
        />
        {errors.description ? (
          <p className="text-sm text-destructive">{errors.description.message}</p>
        ) : null}
      </div>

      <div className="space-y-2">
        <Label htmlFor="status">Status</Label>
        <Controller
          control={control}
          name="status"
          render={({ field }) => (
            <Select value={field.value} onValueChange={field.onChange}>
              <SelectTrigger id="status">
                <SelectValue placeholder="Select status" />
              </SelectTrigger>
              <SelectContent>
                {BOUTIQUE_STATUSES.map((status) => (
                  <SelectItem key={status} value={status}>
                    {BOUTIQUE_STATUS_LABELS[status]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        />
      </div>

      <Controller
        control={control}
        name="telegramQueued"
        render={({ field }) => (
          <div className="flex items-center gap-2">
            <Checkbox
              id="telegramQueued"
              checked={field.value}
              onCheckedChange={(checked) => field.onChange(checked === true)}
            />
            <Label htmlFor="telegramQueued" className="font-normal">
              Queue for Telegram
            </Label>
          </div>
        )}
      />

      <div className="flex justify-end gap-2 pt-2">
        <Button type="submit" disabled={isSubmitting}>
          {isSubmitting ? "Saving..." : submitLabel}
        </Button>
      </div>
    </form>
  );
}
