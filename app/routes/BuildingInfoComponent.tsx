import { useState } from "react";
import { BuildingInfo } from "./Services";

function BuildingInfoComponent({
  buildingInfo,
}: {
  buildingInfo: BuildingInfo | undefined;
}) {
  return buildingInfo === undefined ? (
    <div>Not available</div>
  ) : (
    <div>
      <div className="grid grid-cols-[auto_max-content] gap-1">
        <span className="font-medium">Year of construction</span>
        <span className="text-right">{buildingInfo.year}</span>
        <span className="font-medium">Type</span>
        <span className="text-right">{buildingInfo.propertyType}</span>
        <span className="font-medium">Designation</span>
        <span className="text-right">{buildingInfo.designation}</span>
        <span className="font-medium">Closed net area</span>
        <span className="text-right">{buildingInfo.closedNetArea} m²</span>
        <span className="font-medium">Energy class</span>
        <span className="text-right">
          {buildingInfo.energyClass === undefined
            ? "N/A"
            : buildingInfo.energyClass}
        </span>
      </div>
      <div className="border-t pt-2 mt-2 flex flex-col gap-2">
        <button
          onClick={() => {
            window.open(
              `https://livekluster.ehr.ee/ui/ehr/v1/building/${buildingInfo.ehr}`,
            );
          }}
        >
          Find out more
        </button>
      </div>
    </div>
  );
}

export default BuildingInfoComponent;
