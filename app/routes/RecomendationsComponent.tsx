function RecomendationsComponent() {
  return (
    <div>
      <p>You should think about increasing the insulation </p>

      <div className="border-t pt-2 mt-2 flex flex-col gap-2">
        <button
          onClick={() => {
            window.open("/renovationSelection.html");
          }}
        >
          Check our AI advisor
        </button>
      </div>
    </div>
  );
}

export default RecomendationsComponent;
