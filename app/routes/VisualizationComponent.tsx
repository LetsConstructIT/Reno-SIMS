import { useEffect, useState } from "react";
import {
  getBuildingCodes,
  getBuildingInfo,
  getBuildingParticles,
  getBuildingCodesAndGeometry,
  calculateBoundingBox,
  extendBoundingBox,
} from "./Services";
import proj4 from "proj4";

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
      setCityGmlUrl(
        `https://devkluster.ehr.ee/api/3dtwin/v1/rest-api/citygml?type=terrain&bbox=${bbox.minY}&bbox=${bbox.minX}&bbox=${bbox.maxY}&bbox=${bbox.maxX}`,
      );

      const extendedBbox = extendBoundingBox(bbox, 100);
      console.log(extendedBbox);

      proj4.defs(
        "EPSG:3301",
        "+proj=lambert_conformal_conic +lat_0=57.51755393055556 +lon_0=24 +lat_1=58 +lat_2=59.33333333333334 +x_0=500000 +y_0=6375000 +datum=ETRS89 +units=m +no_defs",
      );

      const [minLon, minLat] = proj4("EPSG:3301", "EPSG:4326", [
        extendedBbox.minX,
        extendedBbox.minY,
      ]);
      const [maxLon, maxLat] = proj4("EPSG:3301", "EPSG:4326", [
        extendedBbox.maxX,
        extendedBbox.maxY,
      ]);

      console.log(`${minLon},${minLat},${maxLon},${maxLat}`);

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
