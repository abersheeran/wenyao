import * as React from "react";
import { Button } from "../../ui/button";
import Input from "../../ui/input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "../../ui/dialog";

export function DeleteConfirmationDialog({
  open,
  onOpenChange,
  title,
  description,
  expectedInput,
  onConfirm,
  isDeleting,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  title: string;
  description: string;
  expectedInput: string;
  onConfirm: () => void;
  isDeleting?: boolean;
}) {
  const [inputValue, setInputValue] = React.useState("");

  // Reset input when dialog opens/closes
  React.useEffect(() => {
    if (!open) {
      setInputValue("");
    }
  }, [open]);

  const isValid = inputValue === expectedInput;

  const handleConfirm = () => {
    if (isValid) {
      onConfirm();
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && isValid) {
      handleConfirm();
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div>
            <label className="text-sm font-medium text-gray-700 mb-2 block">
              Please type <span className="font-mono bg-gray-100 px-1 py-0.5 rounded">{expectedInput}</span> to confirm:
            </label>
            <Input
              value={inputValue}
              onChange={(e) => setInputValue(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={expectedInput}
              autoFocus
            />
          </div>
          <div className="flex justify-end gap-2">
            <Button
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={isDeleting}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={handleConfirm}
              disabled={!isValid || isDeleting}
            >
              {isDeleting ? "Deleting..." : "Delete"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
