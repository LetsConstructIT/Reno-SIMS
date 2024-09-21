import { createFileRoute, useRouter } from "@tanstack/react-router";
import AddressComponent from "./AdressComponent";
import BuildingInfoComponent from "./BuildingInfoComponent";
import RestrictionsComponent from "./RestrictionsComponent";
import VisualizationComponent from "./VisualizationComponent";
import RecomendationsComponent from "./RecomendationsComponent";
import CostsComponent from "./CostsComponent";
import { useState } from "react";
import CardComponent from "./CardComponent";

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
      <AddressComponent sendAddressToParent={handleDataFromChild} />
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
          <CardComponent title="Costs">
            <CostsComponent />
          </CardComponent>
        </div>
      </div>
    </div>
  );
}
