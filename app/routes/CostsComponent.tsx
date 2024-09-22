function CostsComponent() {
  return (
    <div>
      <div className="grid grid-cols-[auto_max-content] gap-1">
        <span className="font-medium">Structural</span>
        <span className="text-right">30,000€</span>
        <span className="font-medium">Energetic improvements</span>
        <span className="text-right">20,000€</span>
        <span className="font-medium">Labor</span>
        <span className="text-right">20,000€</span>
        <span className="font-medium">Contingency (10%)</span>
        <span className="text-right">7,000€</span>
        <span className="font-medium">Total</span>
        <span className="text-right">77,000€</span>
      </div>
      <span className="text-sm">
        does not include{" "}
        <span className="border-b-2 border-dashed border-sky-300 text-sky-500">
          fees
        </span>{" "}
        and{" "}
        <span className="border-b-2 border-dashed border-sky-300 text-sky-500">
          interior renovation
        </span>
      </span>
      <div className="border-t pt-2 mt-2 flex flex-col gap-2">
        <button>Find government support</button>
        <button>Find home loans</button>
      </div>
    </div>
  );
}

export default CostsComponent;
