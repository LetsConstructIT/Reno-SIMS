export async function getBuildingCodes(fullAddress: string): Promise<number[]> {
  const apiUrl =
    "https://devkluster.ehr.ee/api/geoinfo/v1/getgeoobjectsbyaddress";
  try {
    const response = await fetch(
      `${apiUrl}?address=${encodeURIComponent(fullAddress)}`,
      {
        headers: {
          Accept: "application/json",
        },
      },
    );
    if (!response.ok) {
      throw new Error("Error fetching building codes");
    }
    const data = await response.json();
    const buildingCodes = [];
    data.forEach((feature) => {
      const objectCode = feature.properties?.object_code;
      if (objectCode) {
        buildingCodes.push(objectCode);
      }
    });
    return buildingCodes;
  } catch (error) {
    console.error(error);
    alert("Error fetching building codes.");
    return null;
  }
}

export async function getBuildingParticles(buildingCodes: number[]) {
  const apiUrl = "https://devkluster.ehr.ee/api/3dtwin/v1/rest-api/particles";
  try {
    const response = await fetch(apiUrl, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(buildingCodes),
    });
    if (!response.ok) {
      throw new Error("Error fetching data from API");
    }
    const data = await response.json();
    return data;
  } catch (error) {
    console.error(error);
    alert("Error fetching data from API.");
    return null;
  }
}

export async function getBuildingInfo(ehrCode: string): Promise<BuildingInfo> {
  const body = { ehrCodes: [ehrCode] };
  const apiUrl = "https://devkluster.ehr.ee/api/building/v2/buildingsData";
  try {
    const response = await fetch(apiUrl, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      throw new Error("Error fetching building info");
    }
    const data = await response.json();

    const object = data[0];
    console.log(object);

    var designation = object.ehitis.ehitiseAndmed.nimetus;
    var propertyType = object.ehitis.ehitisePohiandmed.omandiLiikTxt;
    const year = object.ehitis.ehitiseAndmed.esmaneKasutus;

    const ehr = object.ehitis.ehitiseKujud.ruumikuju[0].ehrKood;
    const x = object.ehitis.ehitiseKujud.ruumikuju[0].viitepunktX;
    const y = object.ehitis.ehitiseKujud.ruumikuju[0].viitepunktY;
    // should be sorted by date
    var energyClass = undefined;
    if (object.ehitis.ehitiseEnergiamargised.energiamargis.length > 0)
      energyClass =
        object.ehitis.ehitiseEnergiamargised.energiamargis[0].energiaKlass;

    var closedNetArea =
      object.ehitis.ehitiseKehand.kehand[0].ehitiseOsad.ehitiseOsa[0]
        .ehitiseOsaPohiandmed.pind;

    var cadastralCode =
      object.ehitis.ehitiseKatastriyksused.ehitiseKatastriyksus[0]
        .katastritunnus;

    console.log(cadastralCode);
    const info: BuildingInfo = {
      designation: designation,
      propertyType: propertyType,
      ehr: ehr,
      year: year,
      centerX: x,
      centerY: y,
      energyClass: energyClass,
      closedNetArea: closedNetArea,
      cadastralCode: cadastralCode,
    };
    return info;
  } catch (error) {
    console.error(error);
    alert("Error fetching building codes.");
    return null;
  }
}

export type BuildingInfo = {
  designation: string;
  propertyType: string;
  ehr: number;
  year: string;
  centerX?: number;
  centerY?: number;
  energyClass?: string;
  closedNetArea: number;
  cadastralCode: string;
};

export async function getBuildingCodesAndGeometry(fullAddress: string) {
  const apiUrl =
    "https://devkluster.ehr.ee/api/geoinfo/v1/getgeoobjectsbyaddress";
  try {
    const response = await fetch(
      `${apiUrl}?address=${encodeURIComponent(fullAddress)}`,
      {
        method: "GET",
        headers: {
          Accept: "application/json",
        },
      },
    );
    if (!response.ok) throw new Error(`HTTP error! Status: ${response.status}`);
    const data = await response.json();
    const buildingDataList = data
      .map((feature) => {
        const properties = feature.properties || {};
        const geometry = feature.geometry || {};
        const objectCode = properties.object_code;
        if (objectCode && Object.keys(geometry).length > 0) {
          return {
            object_code: objectCode,
            geometry: geometry,
          };
        }
        return null;
      })
      .filter((item) => item !== null);
    return buildingDataList;
  } catch (error) {
    console.error("Error fetching building codes:", error);
    throw error;
  }
}

// Function to calculate the bounding box of all buildings
export function calculateBoundingBox(buildingDataList) {
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;

  buildingDataList.forEach((building) => {
    const geometry = building.geometry || {};
    if (geometry.type === "Polygon") {
      const coordinatesList = geometry.coordinates || [];
      if (coordinatesList.length > 0) {
        const exteriorRing = coordinatesList[0];
        exteriorRing.forEach((coord) => {
          const [x, y] = coord;
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        });
      }
    } else if (geometry.type === "MultiPolygon") {
      const coordinatesList = geometry.coordinates || [];
      coordinatesList.forEach((polygon) => {
        const exteriorRing = polygon[0];
        exteriorRing.forEach((coord) => {
          const [x, y] = coord;
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        });
      });
    }
  });

  return { minX, minY, maxX, maxY };
}

// Function to extend the bounding box by a specified distance (e.g., 100 meters)
export function extendBoundingBox(bbox, distance) {
  return {
    minX: bbox.minX - distance,
    minY: bbox.minY - distance,
    maxX: bbox.maxX + distance,
    maxY: bbox.maxY + distance,
  };
}
