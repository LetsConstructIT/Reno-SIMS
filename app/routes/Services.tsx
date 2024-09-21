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
  year: string;
  centerX?: number;
  centerY?: number;
  energyClass?: string;
  closedNetArea: number;
  cadastralCode: string;
};
