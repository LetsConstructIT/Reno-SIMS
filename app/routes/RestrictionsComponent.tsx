import { useEffect } from "react";

function RestrictionsComponent({
  cadastreUnit,
}: {
  cadastreUnit: string | undefined;
}) {
  /*
  useEffect(() => {
    const fetchData = async () => {
      if (cadastreUnit === undefined) return;

      const response = await fetch(
        `https://kitsendused.kataster.ee/api/v2/cadastre-unit/restrictions?cadastreUnit=${cadastreUnit}&page=0&pageSize=1000`,
      );
      if (!response.ok) {
        throw new Error("Error fetching building codes");
      }
      const data = await response.json();

      console.log(data);
    };

    // call the function
    fetchData()
      // make sure to catch any error
      .catch(console.error);
  }, [cadastreUnit]);
*/
  return (
    <div>
      <p>There is a high-voltage line nearby</p>
    </div>
  );
}

export default RestrictionsComponent;
