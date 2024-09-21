import { useEffect, useState } from "react";
import {
  getBuildingCodes,
  getBuildingInfo,
  getBuildingParticles,
} from "./Services";

function VisualizationComponent({
  address,
  city,
}: {
  address: string;
  city: string;
}) {
  const [coords, setCoords] = useState("x=542084&y=6587844");
  const [cadastralCode, setCadastralCode] = useState("78401:109:3120");

  useEffect(() => {
    const fetchData = async () => {
      if (address.length === 0) return;
      const fullAddress = `${city}, ${address}`;
      const buildingCodes = await getBuildingCodes(fullAddress);
      //const particles = await getBuildingParticles(buildingCodes);
      //console.log(particles);

      const ehr = buildingCodes[0]; //"101036328";
      const buildingData = await getBuildingInfo(ehr);
      console.log(buildingData);

      setCoords(`x=${buildingData.centerX}&y=${buildingData.centerY}`);
      setCadastralCode(buildingData.cadastralCode);
    };

    // call the function
    fetchData()
      // make sure to catch any error
      .catch(console.error);
  }, [address]);

  return (
    <div>
      <div className="flex flex-col justify-center">
        <iframe
          src={`https://fotoladu.maaamet.ee/etak.php?${coords}`}
          height={400}
        />
        <img src={`https://kypilt.kataster.ee/api/${cadastralCode}`} />
      </div>
    </div>
  );
}

export default VisualizationComponent;
