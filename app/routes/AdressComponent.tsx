import { useState } from "react";

function AddressComponent({ sendAddressToParent }) {
  const [city, setCity] = useState("Tallinn");
  const [address, setAddress] = useState("");

  function handleVisualize() {
    sendAddressToParent(city, address);
  }

  return (
    <div className="p-4 flex justify-center">
      <select
        id="city-select"
        value={city}
        onChange={(item) => setCity(item.target.value)}
      >
        <option value="Tallinn">Tallinn</option>
        <option value="Tartu">Tartu</option>
        <option value="Narva">Narva</option>
        <option value="Pärnu">Pärnu</option>
        <option value="Kohtla-Järve">Kohtla-Järve</option>
        <option value="Viljandi">Viljandi</option>
        <option value="Rakvere">Rakvere</option>
        <option value="Maardu">Maardu</option>
        <option value="Sillamäe">Sillamäe</option>
        <option value="Kuressaare">Kuressaare</option>
      </select>

      <input
        type="text"
        className="mx-4"
        id="address-input"
        placeholder="Enter address"
        onChange={(e) => setAddress(e.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            handleVisualize();
          }
        }}
      />

      <button id="visualize-button" onClick={handleVisualize}>
        Visualize
      </button>
    </div>
  );
}

export default AddressComponent;
