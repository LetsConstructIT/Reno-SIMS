import { useEffect, useState } from "react";
import {
  getBuildingCodes,
  getBuildingInfo,
  getBuildingParticles,
  getBuildingCodesAndGeometry,
  calculateBoundingBox,
  extendBoundingBox,
} from "./Services";

function VisualizationComponent({
  address,
  city,
  sendBuildingInfoToParent,
}: {
  address: string;
  city: string;
  sendBuildingInfoToParent: any;
}) {
  const [coords, setCoords] = useState("x=542084&y=6587844");
  const [cadastralCode, setCadastralCode] = useState("78401:109:3120");
  const [cityGmlUrl, setCityGmlUrl] = useState(
    "https://devkluster.ehr.ee/api/3dtwin/v1/rest-api/citygml?type=terrain&bbox=6587732&bbox=542018&bbox=6587871&bbox=542128",
  );

  useEffect(() => {
    const fetchData = async () => {
      if (address.length === 0) return;
      const fullAddress = `${city}, ${address}`;
      const buildingCodes = await getBuildingCodes(fullAddress);
      //const particles = await getBuildingParticles(buildingCodes);
      //console.log(particles);

      const buildingDataList = await getBuildingCodesAndGeometry(fullAddress);
      // Calculate bounding box and extend it by 100 meters
      const bbox = calculateBoundingBox(buildingDataList);
      const extendedBbox = extendBoundingBox(bbox, 100);

      setCityGmlUrl(
        `https://devkluster.ehr.ee/api/3dtwin/v1/rest-api/citygml?type=terrain&bbox=${extendedBbox.minY}&bbox=${extendedBbox.minX}&bbox=${extendedBbox.maxY}&bbox=${extendedBbox.maxX}`,
      );

      const ehr = buildingCodes[0].toLocaleString(); //"101036328";
      const buildingData = await getBuildingInfo(ehr);

      sendBuildingInfoToParent(buildingData);
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
        <iframe src={`./citygml.html?url=${cityGmlUrl}`} height={400} />
        <div className="flex my-4 justify-center">
          <iframe
            src={`https://fotoladu.maaamet.ee/etak.php?${coords}`}
            className="mr-4"
          />
          <img src={`https://kypilt.kataster.ee/api/${cadastralCode}`} />
        </div>
      </div>
    </div>
  );
}

export default VisualizationComponent;
