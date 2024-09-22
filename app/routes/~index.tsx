import { useState } from "react";
import { createFileRoute, useRouter } from "@tanstack/react-router";

import AddressComponent from "./AdressComponent";
import BuildingInfoComponent from "./BuildingInfoComponent";
import CardComponent from "./CardComponent";
import CostsComponent from "./CostsComponent";
import RecomendationsComponent from "./RecomendationsComponent";
import RestrictionsComponent from "./RestrictionsComponent";
import VisualizationComponent from "./VisualizationComponent";

export const Route = createFileRoute("/")({
  component: Home,
});

function Home() {
  const router = useRouter();
  const state = Route.useLoaderData();

  const [address, setAddress] = useState("");
  const [city, setCity] = useState("");

  function handleDataFromChild(city: string, address: string) {
    setCity(city);
    setAddress(address);
  }

  return (
    <div>
      <div className="grid grid-cols-[1fr_600px_1fr] gap-2">
        <div></div>
        <AddressComponent sendAddressToParent={handleDataFromChild} />
        <div className="flex justify-end p-4 gap-4">
          <button>Share</button>
          <button>Save</button>
        </div>
      </div>
      <div className="flex">
        <div className="w-1/5 mx-8">
          <CardComponent title="Building data">
            <BuildingInfoComponent />
          </CardComponent>
          <CardComponent title="Restrictions">
            <RestrictionsComponent />
          </CardComponent>
        </div>
        <div className="w-3/5">
          <VisualizationComponent address={address} city={city} />
        </div>
        <div className="w-1/5 mx-8">
          <CardComponent title="Recomendations">
            <RecomendationsComponent />
          </CardComponent>
          <CardComponent title="Cost Estimate">
            <CostsComponent />
          </CardComponent>
        </div>
      </div>
    </div>
  );
}
